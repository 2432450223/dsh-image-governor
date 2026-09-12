/**
 * Kernel-level verification of the release/restore writes.
 *
 * These are not paraphrased expectations: every append the plugin builds is fed
 * through the real `foldSurface` validator from `dsh-session`, the same code the
 * live Session runs at its append boundary. A payload that folds is a payload
 * the kernel accepts; the negative controls prove the fold is actually enforcing.
 *
 * Run: node --import tsx/esm .test_release_kernel.mjs
 */
import {
  buildReleaseAppend, collectImageInventory, planImageRelease, planImageRestore,
} from '../lib/index.js'

// The kernel validator is TypeScript in the DSH checkout, so this suite needs both
// that checkout and tsx:
//   DSH_CHECKOUT=/path/to/deepseek-harness node --import tsx/esm test/kernel.release.mjs
const checkout = process.env.DSH_CHECKOUT
if (checkout === undefined) {
  console.log('SKIP  内核校验需要 DSH_CHECKOUT 指向 deepseek-harness 检出')
  process.exit(0)
}
const { foldSurface } = await import(new URL(
  'packages/core/session/src/surface.ts',
  `file:///${checkout.replace(/\\/g, '/').replace(/\/+$/, '')}/`,
).href)

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `: ${detail}`}`)
}

const IMAGE = (id, bytes, name) => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes, name } })

/** A contiguous log: foldSurface asserts seq === index with baseSeq 0. */
function baseLog() {
  return [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '开始' }], source: 'input' } },
    { seq: 1, type: 'tool/result', surfaceOp: 'append', data: { turn: 2, step: 5, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [IMAGE('sha256:a', 1_000_000, 'one.png')], result: 'ok' }] } } },
    { seq: 2, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [IMAGE('sha256:b', 500_000, 'two.png')], source: 'input' } },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 6, message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } } },
  ]
}

function sessionOf(log, nodes) {
  return { surface: { nodes: nodes ?? foldSurface(log).nodes }, events: log }
}

const log = baseLog()
const baseline = foldSurface(log)
check('基线：4 个节点全部可见', JSON.stringify(baseline.nodes) === '[0,1,2,3]', JSON.stringify(baseline.nodes))
check('基线：读到 2 张图', collectImageInventory(sessionOf(log)).imageBlocks === 2,
  String(collectImageInventory(sessionOf(log)).imageBlocks))

// --- the plugin's own plan, and the kernel's verdict on its appends ---
const plan = planImageRelease(sessionOf(log), { keep: [], newest: 0 })
check('计划移出 2 个节点', plan.released.length === 2, plan.released.map(item => `seq ${item.seq}`).join(','))
check('计划释放字节合计', plan.freedRawBytes === 1_500_000, String(plan.freedRawBytes))

const extended = [...log]
for (const item of plan.released) {
  extended.push({ seq: extended.length, type: item.type, surfaceOp: item.intent.surfaceOp, sourceEventSeqs: item.intent.sourceEventSeqs, data: item.data })
}
let folded
try {
  folded = foldSurface(extended)
  check('内核接受全部替换事件', true)
} catch (error) {
  check('内核接受全部替换事件', false, String(error.message))
  folded = { nodes: [], replacements: [] }
}
check('替换后 surface 变成 [0,4,5,3]', JSON.stringify(folded.nodes) === '[0,4,5,3]', JSON.stringify(folded.nodes))
check('记录了 2 次位置替换', folded.replacements.length === 2, String(folded.replacements.length))
const afterRelease = collectImageInventory(sessionOf(extended, folded.nodes))
check('改写后模型看不到任何图片', afterRelease.imageBlocks === 0, String(afterRelease.imageBlocks))
check('文本节点未受影响', folded.nodes.includes(0) && folded.nodes.includes(3))

// --- restore round trip through the same validator ---
const restorePlan = planImageRestore(sessionOf(extended, folded.nodes))
check('找到 2 个占位符节点可恢复', restorePlan.restores.length === 2,
  restorePlan.restores.map(item => `seq ${item.seq}←${item.originalSeq}`).join(','))
const restored = [...extended]
for (const item of restorePlan.restores) {
  restored.push({ seq: restored.length, type: item.type, surfaceOp: item.intent.surfaceOp, sourceEventSeqs: item.intent.sourceEventSeqs, data: item.data })
}
const refolded = foldSurface(restored)
const afterRestore = collectImageInventory(sessionOf(restored, refolded.nodes))
check('恢复后图片重新可见', afterRestore.imageBlocks === 2, `${afterRestore.imageBlocks} 张 · ${afterRestore.rawBytes} B`)
check('恢复去重数正确', afterRestore.uniqueAttachments === 2, String(afterRestore.uniqueAttachments))

// --- keep selection ---
const keepByName = planImageRelease(sessionOf(log), { keep: ['one.png'], newest: 0 })
check('按文件名保留只移出另一张', keepByName.released.length === 1 && keepByName.kept[0].seq === 1,
  `released=${keepByName.released.map(i => i.seq)} kept=${keepByName.kept.map(i => i.seq)}`)
const keepBySeq = planImageRelease(sessionOf(log), { keep: ['2'], newest: 0 })
check('按 seq 保留生效', keepBySeq.released.length === 1 && keepBySeq.released[0].seq === 1)
const keepNewest = planImageRelease(sessionOf(log), { keep: [], newest: 1 })
check('--newest 1 保留最后一个带图节点', keepNewest.kept.map(entry => entry.seq).join(',') === '2')
check('未知 keep 参数被报出而非忽略',
  planImageRelease(sessionOf(log), { keep: ['nope.png'], newest: 0 }).unmatched.join(',') === 'nope.png')

// --- refusals the plugin must make itself ---
const imageFirstBlock = { seq: 0, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', content: [IMAGE('sha256:c', 10, 'first.png')] } } }
const firstBlockRefused = buildReleaseAppend(imageFirstBlock)
check('图片占首个块的 tool/result 被拒绝改写', firstBlockRefused.ok === false, firstBlockRefused.reason)
const nestedElsewhere = { seq: 0, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'x' }] }, { type: 'text', content: [IMAGE('sha256:d', 10, 'deep.png')] }] } } }
const deepRefused = buildReleaseAppend(nestedElsewhere)
check('图片在兄弟块里时拒绝半改写', deepRefused.ok === false, deepRefused.reason)
check('非 surface 类型被拒绝', buildReleaseAppend({ seq: 0, type: 'tool/call', data: { name: 'x' } }).ok === false)

// --- negative controls: the fold must be enforcing, not merely permissive ---
function mustThrow(name, events, pattern) {
  let message = '没有抛错'
  try {
    foldSurface(events)
  } catch (error) {
    message = String(error.message)
  }
  check(name, pattern.test(message), message)
}
mustThrow('拒绝：改动 turn 违反「只能改 content」',
  [...log, { seq: 4, type: 'tool/result', surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1], data: { ...log[1].data, turn: 99, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }], result: 'ok' }] } } }],
  /only content/)
mustThrow('拒绝：漏报被 shadow 的节点',
  [...log, { seq: 4, type: 'tool/result', surfaceOp: { op: 'replace', start: 1, end: 1 }, data: { ...log[1].data, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }], result: 'ok' }] } } }],
  /must include every shadowed/)
mustThrow('拒绝：surfaceOp 带多余字段',
  [...log, { seq: 4, type: 'tool/result', surfaceOp: { op: 'replace', start: 1, end: 1, extra: 1 }, sourceEventSeqs: [1], data: { ...log[1].data, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }], result: 'ok' }] } } }],
  /invalid replace surfaceOp|surfaceOp/)
mustThrow('拒绝：替换已被替换的节点',
  [...log,
    { seq: 4, type: 'tool/result', surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1], data: { ...log[1].data, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }], result: 'ok' }] } } },
    { seq: 5, type: 'tool/result', surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1], data: { ...log[1].data, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'y' }], result: 'ok' }] } } }],
  /not found in surface/)
mustThrow('拒绝：surface 事件缺 surfaceOp 标记',
  [{ seq: 0, type: 'user/message', data: { role: 'user', content: [] } }],
  /requires a surfaceOp marker/)

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
