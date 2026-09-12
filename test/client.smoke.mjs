/**
 * Client-half verification for dsh-image-governor.
 *
 * Part one evaluates the real `lib/client.js` the way the browser module table
 * does — stub loader, baseline-only `require`, hostile contexts — because a
 * module that fails to evaluate is a fatal boot entry no in-apply guard can catch.
 * Part two drives the frame-wide pill through a minimal hooks runtime and asserts
 * the picker's contract: nothing selected on open, selection is the action's
 * object, the submitted line keeps the complement, wording stays operator-facing,
 * and every applied change offers an undo.
 */
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `: ${detail}`}`)
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

// ---- host stub: answers the three endpoints the picker uses ----
const fetched = []
const postBodies = []
const SESSION = 'session-test'
const SESSIONS = [{ sessionId: SESSION, title: '电商套图', images: 3, historyBytes: 1_700_000, offloadedImages: 2, shippedBase64Bytes: 666_667 }]
const IMAGES = [
  { seq: 11, type: 'tool/result', turn: 2, step: 5, name: 'ref.png', attachmentId: 'sha256:a', mediaType: 'image/png', bytes: 900_000, base64Bytes: 1_200_000, shipped: false },
  { seq: 22, type: 'user/message', turn: 3, step: 1, name: 'mid.png', attachmentId: 'sha256:b', mediaType: 'image/png', bytes: 300_000, base64Bytes: 400_000, shipped: false },
  { seq: 33, type: 'tool/result', turn: 9, step: 4, name: 'new.png', attachmentId: 'sha256:c', mediaType: 'image/png', bytes: 500_000, base64Bytes: 666_667, shipped: true },
]
const inventory = {
  ok: true, sessionId: SESSION, provider: 'huaapip', capBytes: 2_500_000, surfaceNodes: 40,
  historyBytes: 1_700_000, historyBase64Bytes: 2_266_667, shippedBase64Bytes: 666_667,
  offloadedImages: 2, placeholders: 0, images: IMAGES,
}
let runAnswer = { ok: true, kind: 'success', text: '已移出 2 个节点的 2 张图。' }
globalThis.fetch = async (url, options) => {
  const target = String(url)
  fetched.push(target)
  if (typeof options?.body === 'string') {
    try {
      postBodies.push(JSON.parse(options.body))
    } catch {
      postBodies.push({ unparsable: true })
    }
  }
  const json = (value) => ({ status: 200, json: async () => value })
  if (target.startsWith('/api/image-governor/sessions')) return json({ ok: true, sessions: SESSIONS })
  if (target.startsWith('/api/image-governor/inventory')) return json(inventory)
  if (target.startsWith('/api/image-governor/run')) return json(runAnswer)
  return json({ ok: false, error: `未预料的请求 ${target}` })
}

// ---- a minimal hooks runtime with per-component state ----
const hookStore = new WeakMap()
let hookIndex = 0
let pendingEffects = []
const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (initial) => {
    const state = hookStore.get(stubReact.__current)
    const index = hookIndex++
    if (!(index in state)) state[index] = initial
    return [state[index], (next) => {
      state[index] = typeof next === 'function' ? next(state[index]) : next
    }]
  },
  useCallback: (fn) => fn,
  useEffect: (fn) => { pendingEffects.push(fn) },
}
function renderComponent(Component, props) {
  if (!hookStore.has(Component)) hookStore.set(Component, [])
  stubReact.__current = Component
  hookIndex = 0
  pendingEffects = []
  const node = Component({ ...props, children: undefined })
  for (const effect of pendingEffects) effect()
  return node
}
const renderElement = (element) => renderComponent(element.type, element.props)

function textOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, found)
    return found
  }
  if (typeof node === 'string' || typeof node === 'number') found.push(String(node))
  else if (node !== null && typeof node === 'object') textOf(node.props?.children, found)
  return found
}
const text = (node) => textOf(node).join(' ')
/** Every clickable node whose className contains the needle (containers excluded). */
const buttons = (node, needle) => findAll(node, needle).filter(item => typeof item.props?.onClick === 'function')
function findAll(node, needle, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, needle, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (typeof node.props?.className === 'string' && node.props.className.includes(needle)) found.push(node)
  findAll(node.props?.children, needle, found)
  return found
}

check('包内无静态 import（运行时只依赖模块表）', !/^\s*import[\s{*]/m.test(SOURCE))

const injected = []
const documentStub = {
  head: { appendChild: (node) => injected.push(node) },
  body: { textContent: '设置 发送' },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
}
let definition = null
new Function('window', 'document', SOURCE)({ __ModuleLoader__: { load: (given) => { definition = given } } }, documentStub)
check('向模块表注册了自身', definition?.id === 'dsh-image-governor', String(definition?.id))

const required = []
let exports
try {
  exports = definition.factory((name) => {
    required.push(name)
    if (name === 'react') return stubReact
    throw new Error(`非基线依赖：${name}`)
  })
  check('工厂求值成功', true)
} catch (error) {
  check('工厂求值成功', false, String(error.message))
  console.log('1 项失败')
  process.exit(1)
}
check('只 require 了 react', required.length === 1 && required[0] === 'react', required.join(','))
check('不声明硬依赖（避免 PENDING）', Array.isArray(exports.inject) && exports.inject.length === 0)

const silent = { info() {}, warn() {}, error() {} }
const hostile = [
  ['没有 slots', { logger: silent, get: () => undefined }],
  ['get 抛错', { logger: silent, get: () => { throw new Error('no service store') } }],
  ['inject 抛错', { logger: silent, get: () => ({ inject() { throw new Error('slot refuses') } }) }],
  ['register 抛错', { logger: silent, get: () => ({ inject: (_n, fn) => { fn(); return () => {} }, register() { throw new Error('ledger refuses') } }) }],
  ['连 logger 都没有', { get: () => undefined }],
  ['logger 自身抛错', { logger: { info() {}, warn() {}, error() { throw new Error('logger down') } }, get: () => { throw new Error('both broken') } }],
]
for (const [label, ctx] of hostile) {
  let threw = false
  try {
    exports.apply(ctx)
  } catch {
    threw = true
  }
  check(`apply 未外抛：${label}`, !threw)
}

// ---- registration shape ----
const injectCalls = []
const registrations = []
const components = {}
const happy = {
  logger: silent,
  effect(fn) { fn() },
  get: (service) => service === 'slots' ? {
    entries: () => [{}],
    inject(name, factory) {
      injectCalls.push(name)
      factory()
      return () => {}
    },
    register(options, given) {
      registrations.push(options)
      components[options.id ?? options.key] = given
      return () => {}
    },
  } : undefined,
}
exports.apply(happy)
check('注入三个可加 seat',
  injectCalls.join(',') === 'shell.overlay,conversation.session.header.actions,settings.plugin.item',
  injectCalls.join(','))
check('整屏浮层排在首位（不依赖标题栏渲染）', registrations[0]?.id === 'image-governor-pill', JSON.stringify(registrations[0]))
const stylesheet = injected.map(node => node.textContent ?? '').join('\n')
check('面板贴在浮层按钮上方（不再压住输入区）',
  stylesheet.includes('bottom: 56px') || stylesheet.includes('margin: auto'))
check('面板非模态（没有遮罩层）', !stylesheet.includes('dsh-imgov-backdrop'))
check('勾选框改成 20px 自定义样式', stylesheet.includes('appearance: none') && stylesheet.includes('width: 20px; height: 20px'))
check('缩略图尺寸适配窄面板', stylesheet.includes('minmax(148px'))
const reports = postBodies.filter(body => Array.isArray(body?.seats) && body.version !== undefined)
check('自述：三条 seat 全部注册成功',
  reports.some(body => body.ok === true && body.seats.filter(seat => seat.endsWith('#registered')).length === 3),
  JSON.stringify(reports.at(-1) ?? null))

// ---- the frame-wide pill: sessions -> pick -> panel ----
const FramePill = components['image-governor-pill']
let tree = renderComponent(FramePill, {})
await findAll(tree, 'dsh-imgov-btn')[0].props.onClick()
await settle()
tree = renderComponent(FramePill, {})
await settle()
tree = renderComponent(FramePill, {})
const rows = findAll(tree, 'dsh-imgov-row')
check('会话列表用"模型看到 N 张"这种说法', text(rows[0] ?? tree).includes('模型看到 1 张'), text(rows[0] ?? tree))

await rows[0].props.onClick()
tree = renderComponent(FramePill, {})
const panelElement = tree.props.children.find(child => String(child?.props?.sessionId) === SESSION)
let panel = renderElement(panelElement)
await settle()
panel = renderElement(panelElement)

const overview = findAll(panel, 'dsh-imgov-sub')[0]
check('概览是人话，不出现 seq/base64/上限',
  text(overview).includes('模型现在能看到 1 张') && text(overview).includes('另外 2 张已经看不见')
  && !text(panel).includes('base64') && !text(panel).includes('seq '),
  text(overview).slice(0, 120))
const cellTexts = findAll(panel, 'dsh-imgov-cell').map(cellText => text(cellText))
check('每张图说人话（第几轮 · 谁给的 · 大小）',
  cellTexts[0].includes('第 2 轮 · 模型产出的 · 0.86 MB') && cellTexts[1].includes('你粘贴的'), cellTexts[1])
check('只给异常那张打"模型看不见"角标（可见的不打）',
  cellTexts[2].includes('模型看不见') === false && cellTexts[0].includes('模型看不见'), cellTexts[0])
check('预设是 ghost 样式、与主操作区分',
  buttons(panel, 'dsh-imgov-preset').length === 4 && buttons(panel, 'dsh-imgov-primary').length === 1,
  `presets=${buttons(panel, 'dsh-imgov-preset').length} primary=${buttons(panel, 'dsh-imgov-primary').length}`)

const boxes = () => findAll(panel, 'dsh-imgov-cell')
  .map(cell => cell.props.children.find(child => child?.props?.type === 'checkbox')?.props?.checked)
check('打开时一张都没勾选（默认不动任何图）', boxes().join(',') === 'false,false,false', boxes().join(','))
const footer = () => buttons(panel, 'dsh-imgov-primary').at(-1)
check('未选中时主按钮不可用并说明原因',
  footer().props.disabled === true && text(footer()).includes('先勾选图片'), text(footer()))

// Presets decide for the operator instead of making them reason per image.
await buttons(panel, 'dsh-imgov-preset')[0].props.onClick()
panel = renderElement(panelElement)
check('预设"只留最新 1 张"选中其余全部', boxes().join(',') === 'true,true,false', boxes().join(','))
const pickedTexts = findAll(panel, 'dsh-imgov-cell').map(cellText => text(cellText))
check('选中的格子自己标"将移出"、没选的不标',
  pickedTexts[0].includes('将移出') && pickedTexts[2].includes('将移出') === false, pickedTexts[0])
check('主按钮随之写明动作与代价', text(footer()).includes('移出所选的 2 张') && text(footer()).includes('每步少发'), text(footer()))

await footer().props.onClick()
await settle()
const runPost = postBodies.filter(body => typeof body?.line === 'string').at(-1)
check('提交时保留的是未选中的补集', runPost?.line === '/images clear keep 33 --yes', JSON.stringify(runPost ?? null))

panel = renderElement(panelElement)
check('写入后可撤销', text(panel).includes('已移出 2 张') && text(findAll(panel, 'dsh-imgov-undo')[0] ?? panel).includes('撤销'),
  text(findAll(panel, 'dsh-imgov-undo')[0] ?? panel))
await findAll(panel, 'dsh-imgov-undo')[0].props.children[1].props.onClick()
await settle()
check('撤销走 restore 命令', postBodies.filter(body => typeof body?.line === 'string').at(-1)?.line === '/images restore --yes',
  JSON.stringify(postBodies.filter(body => typeof body?.line === 'string').at(-1) ?? null))

// ---- the guard for the failure mode this plugin was diagnosed against ----
runAnswer = { ok: false, kind: 'error', text: '/images clear 未被匹配' }
panel = renderElement(panelElement)
await buttons(panel, 'dsh-imgov-preset')[0].props.onClick()
panel = renderElement(panelElement)
await findAll(panel, 'dsh-imgov-primary').at(-1).props.onClick()
await settle()
panel = renderElement(panelElement)
check('宿主拒绝时显示原因而不是假装成功', text(panel).includes('未被匹配'),
  text(findAll(panel, 'dsh-imgov-error')[0] ?? panel))

// ---- the session-scoped button still registers for standard shells ----
const ImagePicker = components['image-governor-picker']
check('标题栏按钮组件存在且渲染按钮', typeof ImagePicker === 'function'
  && text(renderComponent(ImagePicker, { sessionId: SESSION })).includes('图片'))

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
