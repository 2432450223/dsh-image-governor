/**
 * Offline verification of dsh-image-governor against real session data.
 *
 * Part one runs the plugin's own walker over a fixture extracted from the
 * image-heavy 花api session and compares to ground truth measured independently.
 * Part two checks the payload plan against the bound that route now carries.
 * Part three proves the non-fatal contract: every hostile `ctx` shape leaves
 * `apply` returning normally.
 */
import { readFileSync } from 'node:fs'
import {
  apply, collectImageInventory, formatInventory, planImagePayload, planImageRestore, resolveImageBound, routedProvider,
} from '../lib/index.js'

/** Count image blocks under any number of owned values. */
function collectImagesCheck(values) {
  const found = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (node.type === 'image') found.push(node)
    for (const key of Object.keys(node)) walk(node[key])
  }
  for (const value of values) walk(value)
  return found
}

/**
 * Synthetic surface events with the same structure and aggregate sizes as a real
 * image-heavy session: ten attachments summing to 8,742,473 bytes, nine produced
 * by tools and one pasted by the user. The suite therefore asserts behaviour
 * without shipping anyone's conversation.
 */
function buildFixture() {
  const sizes = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 500_000, 242_473]
  return sizes.map((bytes, index) => {
    const attachment = {
      attachmentId: `sha256:${String(index + 1).repeat(8)}`,
      mediaType: 'image/png', bytes, width: 1024, height: 768,
      name: `shot-${String(index + 1).padStart(2, '0')}.png`,
    }
    const seq = 100 + index * 10
    return index === sizes.length - 1
      ? { seq, type: 'user/message', data: { role: 'user', content: [{ type: 'image', attachment }], source: 'input' } }
      : { seq, type: 'tool/result', data: { turn: index + 1, step: index * 3 + 1, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call_${index}`, content: [{ type: 'image', attachment }], result: 'ok' }] } } }
  })
}
const events = buildFixture()
const session = { surface: { nodes: events.map(event => event.seq) }, events }
const TRUTH = { entries: 10, uniqueAttachments: 10, rawBytes: 8742473 }

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `: ${detail}`}`)
}

const inventory = collectImageInventory(session)
check('带图 surface 事件数', inventory.entriesCarryingImages === TRUTH.entries, String(inventory.entriesCarryingImages))
check('去重附件数', inventory.uniqueAttachments === TRUTH.uniqueAttachments, String(inventory.uniqueAttachments))
check('原始字节', inventory.rawBytes === TRUTH.rawBytes, String(inventory.rawBytes))
check('base64 合计与逐块一致',
  inventory.base64Bytes === inventory.blockBase64.reduce((sum, bytes) => sum + bytes, 0),
  `${inventory.base64Bytes}`)

// The bound this route now carries.
const CAP = 2_500_000
const plan = planImagePayload(inventory, CAP)
check('计划不超上限', plan.shippedBase64Bytes <= CAP, mb(plan.shippedBase64Bytes))
check('张数守恒', plan.shippedBlocks + plan.offloadedBlocks === inventory.blockBase64.length,
  `${plan.shippedBlocks} + ${plan.offloadedBlocks}`)
check('上限之下确实裁剪掉了图', plan.offloadedBlocks > 0, `降级 ${plan.offloadedBlocks} 张`)
check('未给上限时全部保留', planImagePayload(inventory, undefined).offloadedBlocks === 0)
check('上限足够大时不裁剪', planImagePayload(inventory, 1_000_000_000).offloadedBlocks === 0)

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`
}

// Bound resolution: real shape, absent route, absent service, throwing service.
const fakeSettings = (bound) => ({
  get: (ns) => ns === 'llm-pi-ai' ? { providers: { 'example-relay': { maxRequestImageBytes: bound } } } : undefined,
})
check('读到路由上限', resolveImageBound(fakeSettings(2_500_000), 'example-relay') === 2_500_000)
check('未配置该路由时返回 undefined', resolveImageBound(fakeSettings(2_500_000), 'other') === undefined)
check('服务缺失时返回 undefined', resolveImageBound(undefined, 'example-relay') === undefined)
check('设置面抛错时返回 undefined',
  resolveImageBound({ get() { throw new Error('settings unavailable') } }, 'example-relay') === undefined)
check('非正数上限被忽略', resolveImageBound(fakeSettings(0), 'example-relay') === undefined)
check('读不到路由头时返回 undefined',
  routedProvider({ requestHeader() { throw new Error('no header') } }) === undefined)
check('能从会话头取到路由', routedProvider({ requestHeader: () => ({ config: { provider: 'example-relay' } }) }) === 'example-relay')

// Mixed nesting shapes: tool results wrap blocks under content[0].content.
const mixed = {
  surface: { nodes: [1, 2, 3] },
  events: [
    { seq: 1, type: 'user/message', data: { turn: 4, content: [{ type: 'text', text: 'hi' }] } },
    { seq: 2, type: 'tool/result', data: { turn: 4, message: { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'sha256:a', bytes: 1_000_000, name: 'one.png' } }] }] } } },
    { seq: 3, type: 'user/message', data: { turn: 5, content: [{ type: 'image', attachment: { attachmentId: 'sha256:b', bytes: 500_000, name: 'two.png' } }] } },
  ],
}
const nested = collectImageInventory(mixed)
check('两种嵌套形状都读到', nested.imageBlocks === 2, String(nested.imageBlocks))
check('跨形状去重', nested.uniqueAttachments === 2)
check('字节跨形状相加', nested.rawBytes === 1_500_000, String(nested.rawBytes))
check('无图节点不计入', nested.entriesCarryingImages === 2)

// The non-fatal contract.
const silent = { info() {}, warn() {}, error() {} }
const hostile = [
  ['完全没有 commands', { logger: silent, get: () => undefined }],
  ['get 本身抛错', { logger: silent, get: () => { throw new Error('service lookup exploded') } }],
  ['register 抛错', { logger: silent, get: () => ({ register() { throw new Error('registry refused') } }) }],
  ['连 logger 都没有', { get: () => undefined }],
  ['logger 自己也抛错', { logger: { info() {}, warn() {}, error() { throw new Error('logger down') } }, get: () => { throw new Error('both broken') } }],
]
for (const [label, ctx] of hostile) {
  let threw = false
  try {
    apply(ctx)
  } catch {
    threw = true
  }
  check(`apply 未外抛：${label}`, !threw)
}

// End-to-end through the command handler, with and without a resolvable bound.
let registered = null
apply({
  logger: silent,
  effect(fn) { fn() },
  get: (service) => service === 'commands'
    ? { register(definition) { registered = definition; return () => {} } }
    : undefined,
})
check('命令已注册为 /images', registered !== null && typeof registered.handler === 'function')

if (registered !== null) {
  const statusWithBound = await registered.handler({
    rawInput: 'status',
    agent: { session: { ...session, requestHeader: () => ({ config: { provider: 'example-relay' } }) } },
  })
  const answer = await registered.handler({ rawInput: 'status', agent: { session } })
  const clearAnswer = await registered.handler({ rawInput: 'clear', agent: { session } })
  const noSession = await registered.handler({ rawInput: 'status', agent: {} })
  check('status 报出历史与去重数', answer.kind === 'success' && answer.text.includes('去重后 10 张'))
  check('无上限时明说未读到', answer.text.includes('未读到该路由的上限设置'), answer.text.split('\n')[2]?.trim())
  check('子命令拒绝但未注册 settings 时仍可用', statusWithBound.kind === 'success')
  check('clear 默认只预览不写入', clearAnswer.kind === 'success' && clearAnswer.text.includes('未写入'),
    clearAnswer.text.split('\n')[0]?.trim())
  check('未知子命令回用法', (await registered.handler({ rawInput: 'bogus', agent: { session } })).kind === 'error')
  check('restore 空历史时给出说明',
    (await registered.handler({ rawInput: 'restore --yes', agent: { session } })).text.includes('没有本插件移出的图片'))
  check('无会话时返回错误而非抛出', noSession.kind === 'error')

  // Same handler with a settings face wired in: the bound must appear.
  let second = null
  apply({
    logger: silent,
    effect(fn) { fn() },
    get: (service) => service === 'commands'
      ? { register(definition) { second = definition; return () => {} } }
      : service === 'settings' ? fakeSettings(2_500_000) : undefined,
  })
  const capped = await second.handler({
    rawInput: 'status',
    agent: { session: { ...session, requestHeader: () => ({ config: { provider: 'example-relay' } }) } },
  })
  check('报告含实际上线与降级数',
    capped.text.includes('实际每步发送') && capped.text.includes('上限 2.38 MB'),
    capped.text.split('\n').slice(0, 4).join(' / '))
  console.log(`\n--- 带上限的完整输出 ---\n${capped.text}\n`)
}

// The write path end-to-end through the handler, against a recording session.
let registered3 = null
apply({
  logger: silent,
  effect(fn) { fn() },
  get: (service) => service === 'commands'
    ? { register(definition) { registered3 = definition; return () => {} } }
    : undefined,
})
const appended = []
const writableSession = {
  surface: { nodes: session.surface.nodes },
  events: session.events,
  append(type, data, intent) {
    appended.push({ type, data, intent })
    return { seq: 9000 + appended.length }
  },
}
const agentWith = (runMaintenance) => ({ session: writableSession, ...(runMaintenance ? { runMaintenance } : {}) })
const idle = agentWith(job => Promise.resolve(job(new AbortController().signal)))
const busy = agentWith(() => { throw new Error('agent is not idle') })
const cancelled = agentWith(job => { const ac = new AbortController(); ac.abort(); return Promise.resolve(job(ac.signal)) })

const wrote = await registered3.handler({ rawInput: 'clear --yes', agent: idle })
check('clear --yes 报告已移出', wrote.kind === 'success' && wrote.text.includes('已移出'), wrote.text.split('\n').slice(0, 2).join(' / '))
check('每个带图节点各一次替换写入', appended.length === 10, String(appended.length))
check('替换意图是单位置替换且引用被 shadow 节点',
  appended.every(item => item.intent.surfaceOp.op === 'replace'
    && item.intent.surfaceOp.start === item.intent.surfaceOp.end
    && item.intent.sourceEventSeqs.includes(item.intent.surfaceOp.start)))
check('写入的事件自身已不含图片', collectImagesCheck(appended.map(item => item.data)).length === 0)

const byStart = new Map(appended.map((item, index) => [item.intent.surfaceOp.start, 9001 + index]))
const composed = [
  ...session.events,
  ...appended.map((item, index) => ({
    seq: 9001 + index,
    type: item.type,
    data: item.data,
    surfaceOp: item.intent.surfaceOp,
    sourceEventSeqs: item.intent.sourceEventSeqs,
  })),
]
const composedNodes = session.surface.nodes.map(seq => byStart.get(seq) ?? seq)
check('合成后的可见历史图片数为 0',
  collectImageInventory({ surface: { nodes: composedNodes }, events: composed }).imageBlocks === 0,
  String(collectImageInventory({ surface: { nodes: composedNodes }, events: composed }).imageBlocks))
const restoredPlan = planImageRestore({ surface: { nodes: composedNodes }, events: composed })
check('可恢复节点数与写入数一致', restoredPlan.restores.length === 10, String(restoredPlan.restores.length))
check('恢复载荷重新含图', collectImagesCheck(restoredPlan.restores.map(item => item.data)).length === 10)

const busyAnswer = await registered3.handler({ rawInput: 'clear --yes', agent: busy })
check('会话运行中被拒绝且未写入', busyAnswer.kind === 'error' && busyAnswer.text.includes('会话正在运行') && appended.length === 10,
  busyAnswer.text)
const unsupported = await registered3.handler({ rawInput: 'clear --yes', agent: agentWith(undefined) })
check('不支持维护任务时明确报错', unsupported.kind === 'error' && unsupported.text.includes('runMaintenance'))
const cancelledAnswer = await registered3.handler({ rawInput: 'clear --yes', agent: cancelled })
check('已取消时不再写入', cancelledAnswer.kind === 'error' && appended.length === 10)

// Route registration must survive its own effect: registering and disposing in
// the same body is the bug that made both routes 404 in the live host.
const routes = []
const removed = []
const routeCtx = {
  logger: silent,
  collected: [],
  get: (service) => service === 'commands' ? { register: () => () => {} }
    : service === 'webServer' ? {
      register(route) {
        routes.push(route)
        return () => { removed.push(route.path) }
      },
    } : undefined,
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') routeCtx.collected.push(disposer)
    return disposer
  },
}
apply(routeCtx)
const ROUTE_PATHS = '/api/image-governor/inventory,/api/image-governor/thumb,/api/image-governor/report,/api/image-governor/sessions,/api/image-governor/run'
check('注册了五条数据路由', routes.map(route => route.path).join(',') === ROUTE_PATHS,
  routes.map(route => route.path).join(','))
check('路由未在注册时被误卸载', removed.length === 0, removed.join(','))
for (const dispose of routeCtx.collected) dispose()
check('调用收集到的清理正好移除五条路由', removed.join(',') === ROUTE_PATHS, removed.join(','))

/** Drive one route with a Node-shaped response and report what it wrote. */
async function driveRoute(route, url, extra = {}) {
  const written = []
  await route.handler({ url, ...extra }, {
    writeHead(status, headers) { written.push({ status, headers }) },
    end(body) { written.push({ body: String(body).slice(0, 300), raw: String(body) }) },
  })
  return written
}
/** A request body shaped like a readable stream, with one JSON document in it. */
function streamedBody(value) {
  const text = JSON.stringify(value)
  return { [Symbol.asyncIterator]: async function* () { yield new TextEncoder().encode(text) } }
}
const missingSession = await driveRoute(routes[0], '/api/image-governor/inventory?session=does-not-exist')
check('清单路由：未知会话回 404', missingSession[0]?.status === 404, JSON.stringify(missingSession[0]))
check('清单路由：应答是 JSON', String(missingSession[0]?.headers?.['content-type']).includes('application/json'))
const missingThumb = await driveRoute(routes[1], '/api/image-governor/thumb?session=does-not-exist&id=sha256:x')
check('缩略图路由：未知会话回 404', missingThumb[0]?.status === 404, JSON.stringify(missingThumb[0]))

// The report route keeps one bounded client-half self-report, readable by the host.
await driveRoute(routes[2], '/api/image-governor/report', {
  method: 'POST',
  ...streamedBody({
    ok: true,
    version: '0.3.0',
    seats: ['conversation.session.header.actions', 'conversation.session.header.actions#armed'],
    href: '/workspace/x',
    junk: { nested: 'x'.repeat(400) },
  }),
})
const readBack = JSON.parse((await driveRoute(routes[2], '/api/image-governor/report'))[1].raw)
check('自述路由：POST 后可读回', readBack.report?.version === '0.3.0' && readBack.report?.ok === true, JSON.stringify(readBack.report))
check('自述路由：只保留已知字段', readBack.report?.junk === undefined
  && readBack.report?.seats?.includes('conversation.session.header.actions#armed'), JSON.stringify(Object.keys(readBack.report ?? {})))
check('自述路由：超大错误串被截断', await (async () => {
  await driveRoute(routes[2], '/api/image-governor/report', { method: 'POST', ...streamedBody({ error: 'e'.repeat(900) }) })
  const again = JSON.parse((await driveRoute(routes[2], '/api/image-governor/report'))[1].raw)
  return again.report?.error?.length === 400
})())

// A boot-time activation can run before `commands` or `webServer` exists. The
// plugin must wait for the service through ctx.inject instead of dropping that
// surface for the whole process, which is what leaves an installed plugin with
// no command and no HTTP route.
const deferred = []
apply({
  logger: silent,
  effect(fn) { fn() },
  get: () => undefined,
  inject(deps, callback) { deferred.push({ deps, callback }) },
})
check('服务都没就绪时不注册、只挂起等待', deferred.length === 2
  && deferred.map(entry => entry.deps.join(',')).join('|') === 'commands|webServer',
  JSON.stringify(deferred.map(entry => entry.deps)))

const lateRegistrations = []
const lateRoutes = []
const lateScope = {
  logger: silent,
  effect(fn) { fn() },
  get: (service) => service === 'commands'
    ? { register(definition) { lateRegistrations.push(definition); return () => {} } }
    : service === 'webServer'
      ? { register(route) { lateRoutes.push(route); return () => {} } }
      : undefined,
}
for (const entry of deferred) entry.callback(lateScope)
check('服务就绪后补注册 /images 命令',
  lateRegistrations.map(definition => definition.name).join(',') === 'images',
  lateRegistrations.map(definition => definition.name).join(','))
check('服务就绪后补注册五条路由',
  lateRoutes.length === 5 && lateRoutes[0].path === '/api/image-governor/inventory',
  String(lateRoutes.length))

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
