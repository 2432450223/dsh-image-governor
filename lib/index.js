/**
 * dsh-image-governor — host half.
 *
 * `/images status` reports the image payload of the calling agent's model-visible
 * surface in three numbers that are easy to confuse and must not be: what the
 * history carries, what the route's `maxRequestImageBytes` bound lets through,
 * and what therefore actually travels on every step.
 *
 * `/images clear` and `/images restore` move stale images out of, and back into,
 * the model's view by appending positional surface replacements — the same
 * protocol manual compaction uses, which the surface contract explicitly opens
 * to any surface-replacing producer. Nothing is deleted: the append-only log
 * keeps every original event, so a restore re-reads it.
 *
 * Deliberate structure, so a broken plugin can never abort a DSH boot:
 * - no `inject` export: every service is read through `ctx.get`, because an
 *   unresolvable `inject` leaves the fiber PENDING, which the web boot audit
 *   counts as a failure;
 * - `apply` never throws: registration failures are logged and the fiber stays
 *   ACTIVE, so the shell mounts and the settings card still reports the cause;
 * - no value imports from other workspace packages: a missing symbol at module
 *   evaluation would fail the import itself, which no in-apply guard can catch.
 */

export const name = 'image-governor'

const USAGE = 'Usage: /images status | /images clear [keep <seq|文件名> …] [--newest N] [--yes] | /images restore [--yes]'

/**
 * Stable prefix identifying one of this plugin's placeholder blocks. Each
 * placeholder is written once into the durable log and never recomputed, so it
 * can carry detail; the adapter's own transient offload needs a constant string
 * instead because it redecides on every request.
 */
export const PLACEHOLDER_PREFIX = '[image-governor]'

/** Human-readable byte count without locale surprises in command output. */
function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`
}

/** base64 inflates binary payload by four thirds; that is what the link ships. */
function base64Bytes(bytes) {
  return Math.ceil((bytes * 4) / 3)
}

/**
 * Collect every `image` content block under one value, whatever nests it.
 * Message shapes differ: a user message carries blocks directly, a tool result
 * nests its content under `content[0].content`, and an attachment block stores
 * its size under `attachment`.
 */
function collectImages(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (node.type === 'image') {
    const attachment = node.attachment
    found.push({
      attachmentId: typeof attachment?.attachmentId === 'string' ? attachment.attachmentId : undefined,
      name: typeof attachment?.name === 'string' ? attachment.name : undefined,
      mediaType: typeof attachment?.mediaType === 'string' ? attachment.mediaType : undefined,
      bytes: typeof attachment?.bytes === 'number' ? attachment.bytes : 0,
    })
  }
  for (const key of Object.keys(node)) {
    if (key === 'attachmentId') continue
    collectImages(node[key], found)
  }
  return found
}

/** One event's image blocks, reading either message shape. */
function imagesOf(event) {
  return collectImages(event?.data?.message?.content ?? event?.data?.content ?? [], [])
}

/** Build the surface-node view of one session, oldest first. */
function surfaceEvents(session) {
  const nodes = session.surface?.nodes
  const events = session.events
  if (!Array.isArray(nodes) || !Array.isArray(events)) throw new Error('session is not readable')
  const bySeq = new Map()
  for (const event of events) {
    if (typeof event?.seq === 'number') bySeq.set(event.seq, event)
  }
  const ordered = []
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (event !== undefined) ordered.push(event)
  }
  return { bySeq, ordered }
}

/**
 * Inventory the image payload of one session's model-visible surface.
 * @param session - a live Session carrying `surface.nodes` and an `events` snapshot.
 * @returns owned summary data only (no session objects), safe to format or serialize.
 */
export function collectImageInventory(session) {
  if (session === undefined) throw new Error('no session')
  const { ordered } = surfaceEvents(session)

  const entries = []
  const blockBase64 = []
  const flat = []
  const unique = new Map()
  // Surface order is model-visible order, oldest first: the same order the
  // adapter's offload rule walks, so the plan below matches what it ships.
  for (const event of ordered) {
    const images = imagesOf(event)
    if (images.length === 0) continue
    let seqRaw = 0
    let seqBase64 = 0
    for (const image of images) {
      const asBase64 = base64Bytes(image.bytes)
      seqRaw += image.bytes
      seqBase64 += asBase64
      blockBase64.push(asBase64)
      flat.push({
        seq: event.seq,
        type: event.type,
        turn: typeof event.data?.turn === 'number' ? event.data.turn : undefined,
        step: typeof event.data?.step === 'number' ? event.data.step : undefined,
        name: image.name,
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        base64Bytes: asBase64,
      })
      if (image.attachmentId !== undefined && !unique.has(image.attachmentId)) {
        unique.set(image.attachmentId, { bytes: image.bytes, name: image.name })
      }
    }
    entries.push({
      seq: event.seq,
      type: event.type,
      turn: typeof event.data?.turn === 'number' ? event.data.turn : undefined,
      step: typeof event.data?.step === 'number' ? event.data.step : undefined,
      count: images.length,
      bytes: seqRaw,
      base64Bytes: seqBase64,
      names: images.map(image => image.name).filter(Boolean).slice(0, 4),
      ids: images.map(image => image.attachmentId).filter(Boolean),
    })
  }

  let totalBytes = 0
  for (const record of unique.values()) totalBytes += record.bytes
  return {
    surfaceNodes: ordered.length,
    entriesCarryingImages: entries.length,
    imageBlocks: entries.reduce((sum, entry) => sum + entry.count, 0),
    uniqueAttachments: unique.size,
    rawBytes: totalBytes,
    base64Bytes: blockBase64.reduce((sum, bytes) => sum + bytes, 0),
    blockBase64,
    entries,
    images: flat,
  }
}

/**
 * Apply one route's byte bound the way `offloadRequestImages` does: walk the
 * blocks in surface order and drop the oldest until the accumulated base64
 * payload fits. The result is what actually ships on every step.
 * @param inventory - output of {@link collectImageInventory}.
 * @param capBytes - the route's `maxRequestImageBytes`; undefined leaves everything in place.
 * @returns owned shipped-versus-offloaded accounting.
 */
export function planImagePayload(inventory, capBytes) {
  const history = inventory.base64Bytes
  if (capBytes === undefined) {
    return {
      capBytes,
      historyBase64Bytes: history,
      shippedBlocks: inventory.blockBase64.length,
      shippedBase64Bytes: history,
      offloadedBlocks: 0,
    }
  }
  let total = history
  let offloaded = 0
  for (const bytes of inventory.blockBase64) {
    if (total <= capBytes) break
    total -= bytes
    offloaded += 1
  }
  return {
    capBytes,
    historyBase64Bytes: history,
    shippedBlocks: inventory.blockBase64.length - offloaded,
    shippedBase64Bytes: total,
    offloadedBlocks: offloaded,
  }
}

/**
 * Read one route's configured image bound from the effective `llm-pi-ai`
 * section, so the report states the bound the adapter will apply rather than a
 * copy of it that could drift. Absent service, namespace, or route yields
 * undefined, which the caller reports as "unknown" instead of guessing.
 */
export function resolveImageBound(settings, provider) {
  if (settings === undefined || typeof settings.get !== 'function' || provider === undefined) return undefined
  try {
    const bound = settings.get('llm-pi-ai')?.providers?.[provider]?.maxRequestImageBytes
    return typeof bound === 'number' && Number.isFinite(bound) && bound > 0 ? bound : undefined
  } catch {
    // A settings face that refuses to answer is a missing bound, not an error:
    // the report degrades to the history view alone.
    return undefined
  }
}

/** The route the session is currently configured for, or undefined. */
export function routedProvider(session) {
  try {
    const provider = session.requestHeader?.()?.config?.provider
    return typeof provider === 'string' ? provider : undefined
  } catch {
    return undefined
  }
}

/** One placeholder block for one image, naming what was removed and how back. */
function placeholderBlock(image, seq) {
  const label = image.name ?? image.attachmentId ?? '未命名图片'
  return {
    type: 'text',
    text: `${PLACEHOLDER_PREFIX} 图片已按用户要求移出模型上下文：${label} · ${mb(image.bytes ?? 0)}`
      + ` · 原 seq ${seq}；需要时运行 /images restore 取回`,
  }
}

/** Rewrite image blocks to placeholders within one block array. */
function releaseBlocks(blocks, seq) {
  return blocks.map(block => (block?.type === 'image' ? placeholderBlock(block.attachment ?? {}, seq) : block))
}

/** One positional replacement intent over a single current surface node. */
function replaceIntent(seq, extraSources = []) {
  return {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [...new Set([seq, ...extraSources])],
  }
}

/**
 * Build the append that moves one node's images out of the model's view.
 *
 * Each event type has its own payload location, and `tool/result` carries the
 * strictest rule in the kernel: exactly one current node, and only its first
 * content block's `content` may change. Where a rewrite cannot reach every
 * image, the node is refused with the reason rather than half-applied.
 * @returns `{ ok: true, type, data, intent }` or `{ ok: false, reason }`.
 */
export function buildReleaseAppend(original) {
  if (original === undefined) return { ok: false, reason: '找不到该 seq 对应的事件' }
  const seq = original.seq
  const data = original.data
  const next = structuredClone(data)
  if (original.type === 'user/message') {
    if (!Array.isArray(next?.content)) return { ok: false, reason: 'user/message 无 content 数组' }
    next.content = releaseBlocks(next.content, seq)
  } else if (original.type === 'assistant/message') {
    if (!Array.isArray(next?.message?.content)) return { ok: false, reason: 'assistant/message 无 content 数组' }
    next.message.content = releaseBlocks(next.message.content, seq)
  } else if (original.type === 'tool/result') {
    const outer = next?.message?.content
    if (!Array.isArray(outer) || outer.length === 0) return { ok: false, reason: 'tool/result 无 content 数组' }
    if (outer[0]?.type === 'image') {
      return { ok: false, reason: '图片是 tool/result 的首个块，内核只允许改第一个块内的 content' }
    }
    if (Array.isArray(outer[0]?.content)) outer[0].content = releaseBlocks(outer[0].content, seq)
  } else {
    return { ok: false, reason: `不支持替换 ${String(original.type)} 类型的事件` }
  }
  const leftover = collectImages(next, [])
  if (leftover.length > 0) {
    return { ok: false, reason: `该节点的 ${leftover.length} 张图不在可安全改写的位置，已跳过` }
  }
  return { ok: true, type: original.type, data: next, intent: replaceIntent(seq) }
}

/**
 * Which nodes to release: every image-bearing surface node except the kept ones.
 * @param session - the live session to plan against.
 * @param options - `keep` tokens (surface seq, attachment name substring, or full `sha256:…` id) and `newest` count.
 * @returns owned plan: kept nodes, release appends, refusals, and the freed bytes.
 */
export function planImageRelease(session, options = {}) {
  const { bySeq } = surfaceEvents(session)
  const inventory = collectImageInventory(session)
  const tokens = (options.keep ?? []).map(token => String(token).trim()).filter(Boolean)
  const newest = Number.isFinite(options.newest) && options.newest > 0 ? Math.floor(options.newest) : 0
  const keepSeqs = new Set()
  const unmatched = []
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const seq = Number(token)
      if (inventory.entries.some(entry => entry.seq === seq)) keepSeqs.add(seq)
      else unmatched.push(token)
      continue
    }
    const lower = token.toLowerCase()
    const hits = inventory.entries.filter(entry => entry.ids.some(id => id.toLowerCase() === lower)
      || entry.names.some(name => name.toLowerCase().includes(lower)))
    if (hits.length === 0) unmatched.push(token)
    for (const hit of hits) keepSeqs.add(hit.seq)
  }
  if (newest > 0) {
    for (const entry of inventory.entries.slice(-newest)) keepSeqs.add(entry.seq)
  }

  const kept = inventory.entries.filter(entry => keepSeqs.has(entry.seq))
  const released = []
  const refused = []
  for (const entry of inventory.entries) {
    if (keepSeqs.has(entry.seq)) continue
    const built = buildReleaseAppend(bySeq.get(entry.seq))
    if (built.ok) released.push({ ...built, seq: entry.seq, names: entry.names, bytes: entry.bytes, count: entry.count })
    else refused.push({ seq: entry.seq, reason: built.reason, names: entry.names })
  }
  return {
    inventory,
    kept,
    unmatched,
    released,
    refused,
    freedRawBytes: released.reduce((sum, item) => sum + item.bytes, 0),
    freedBase64Bytes: released.reduce((sum, item) => sum + Math.ceil((item.bytes * 4) / 3), 0),
  }
}

/**
 * Plan the inverse of {@link planImageRelease}: every current placeholder node
 * gets its original content back, read from the append-only log.
 * @param session - the live session to plan against.
 * @returns owned plan of restore appends plus nodes that could not be restored.
 */
export function planImageRestore(session) {
  const { bySeq, ordered } = surfaceEvents(session)
  const restores = []
  const skipped = []
  for (const event of ordered) {
    const texts = []
    const gather = (node) => {
      if (Array.isArray(node)) {
        for (const item of node) gather(item)
        return
      }
      if (node === null || typeof node !== 'object') return
      if (node.type === 'text' && typeof node.text === 'string' && node.text.startsWith(PLACEHOLDER_PREFIX)) texts.push(node.text)
      for (const key of Object.keys(node)) gather(node[key])
    }
    gather(event.data)
    if (texts.length === 0) continue
    const originalSeq = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.find(seq => seq !== event.seq) : undefined
    const original = originalSeq === undefined ? undefined : bySeq.get(originalSeq)
    if (original === undefined) {
      skipped.push({ seq: event.seq, reason: '日志里找不到被引用的原始事件' })
      continue
    }
    if (imagesOf(original).length === 0) {
      skipped.push({ seq: event.seq, reason: `原始事件 seq ${originalSeq} 已不含图片` })
      continue
    }
    restores.push({
      type: original.type,
      data: structuredClone(original.data),
      intent: replaceIntent(event.seq, [originalSeq]),
      seq: event.seq,
      originalSeq,
      bytes: imagesOf(original).reduce((sum, image) => sum + image.bytes, 0),
    })
  }
  return { restores, skipped }
}

/**
 * Mark every image with whether the route's bound lets it onto the wire, in
 * surface order. This is the same oldest-first rule as {@link planImagePayload},
 * reported per image so a UI can badge each thumbnail.
 * @param inventory - output of {@link collectImageInventory}.
 * @param capBytes - the route's `maxRequestImageBytes`; undefined ships everything.
 * @returns a new ordered list of image records carrying `shipped`.
 */
export function annotateImageShipment(inventory, capBytes) {
  let remaining = inventory.images.reduce((sum, image) => sum + image.base64Bytes, 0)
  let offloaded = 0
  const marked = inventory.images.map(image => {
    const overBudget = capBytes !== undefined && remaining > capBytes
    if (overBudget) {
      remaining -= image.base64Bytes
      offloaded += 1
    }
    return { ...image, shipped: !overBudget }
  })
  return { images: marked, offloadedImages: offloaded, shippedBase64Bytes: remaining }
}

/** Format one inventory and its payload plan as command output. */
export function formatInventory(inventory, plan) {
  if (inventory.imageBlocks === 0) {
    return `模型可见历史 ${inventory.surfaceNodes} 个节点，没有图片载荷在重发。`
  }
  const lines = [
    `模型可见历史 ${inventory.surfaceNodes} 个节点，其中 ${inventory.entriesCarryingImages} 个节点带图：`,
    `  历史：图片块 ${inventory.imageBlocks} 个，去重后 ${inventory.uniqueAttachments} 张，`
      + `原始 ${mb(inventory.rawBytes)} → base64 约 ${mb(inventory.base64Bytes)}`,
  ]
  if (plan !== undefined && plan.capBytes !== undefined) {
    lines.push(`  实际每步发送：${plan.shippedBlocks} 张 / ${mb(plan.shippedBase64Bytes)}`
      + `（上限 ${mb(plan.capBytes)}，另 ${plan.offloadedBlocks} 张已降级为占位符）`)
  } else if (plan !== undefined) {
    lines.push(`  实际每步发送：全部 ${plan.shippedBlocks} 张 / ${mb(plan.shippedBase64Bytes)}（未读到该路由的上限设置）`)
  }
  lines.push('  明细：')
  for (const entry of inventory.entries.slice(-12)) {
    lines.push(`    seq ${entry.seq}${entry.turn === undefined ? '' : ` turn ${entry.turn}`}`
      + `${entry.step === undefined ? '' : ` step ${entry.step}`} · ${entry.type}`
      + ` · ${entry.count} 图 · ${mb(entry.bytes)}${entry.names.length > 0 ? ` (${entry.names.join(', ')})` : ''}`)
  }
  if (inventory.entries.length > 12) {
    lines.push(`    …另有 ${inventory.entries.length - 12} 个带图节点`)
  }
  return lines.join('\n')
}

/** Format a release plan, before and after confirmation. */
function formatRelease(plan, applied) {
  const lines = []
  if (plan.unmatched.length > 0) {
    lines.push(`未匹配到的 keep 参数：${plan.unmatched.join(', ')}`)
  }
  if (plan.kept.length > 0) {
    lines.push(`保留 ${plan.kept.length} 个节点：${plan.kept.map(entry => `seq ${entry.seq}`
      + (entry.names.length > 0 ? `(${entry.names.join(',')})` : '')).join('、')}`)
  } else {
    lines.push('保留：无（全部移出）')
  }
  if (plan.released.length === 0) {
    lines.push(applied ? '没有需要移出的图片。' : '没有可移出的图片（可能都已保留或不可安全改写）。')
  } else {
    lines.push(`${applied ? '已移出' : '将移出'} ${plan.released.length} 个节点的 ${plan.released.reduce((sum, item) => sum + item.count, 0)} 张图`
      + `，原始 ${mb(plan.freedRawBytes)} → base64 ${mb(plan.freedBase64Bytes)}：`)
    for (const item of plan.released) {
      lines.push(`    seq ${item.seq} · ${item.type} · ${item.names.join(', ') || item.count + ' 图'}`)
    }
  }
  for (const item of plan.refused) {
    lines.push(`    跳过 seq ${item.seq}${item.names.length > 0 ? `(${item.names.join(', ')})` : ''}：${item.reason}`)
  }
  if (!applied) {
    lines.push('未写入。确认无误后加 `--yes` 执行；原图仍在日志里，可用 /images restore 取回。')
  }
  return lines.join('\n')
}

/** Parse `/images …` arguments into a subcommand and its flags. */
function parseArgs(words) {
  const sub = words[0] ?? 'status'
  const keep = []
  let newest = 0
  let confirmed = false
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    if (word === '--yes' || word === '-y') confirmed = true
    else if (word === '--newest') newest = Number(words[index + 1] ?? 1) || 0
    else keep.push(word)
  }
  return { sub, keep, newest, confirmed }
}

/**
 * Register the two surfaces through child fibers that wait for their service.
 *
 * A boot-time activation can run before `commands` or `webServer` exists, and a
 * one-shot `ctx.get` would then drop that surface for the whole process — the
 * failure that leaves an installed plugin with no command and no HTTP route.
 * `ctx.inject` waits in a child fiber, so this plugin's own fiber stays ACTIVE
 * and the surface appears whenever the service does.
 */
function enable(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], commandCtx => registerCommand(commandCtx))
    ctx.inject(['webServer'], routeCtx => registerRoutes(routeCtx))
    return
  }
  // A context without `inject` can only register what is ready right now.
  if (ctx.get('commands') !== undefined) registerCommand(ctx)
  if (ctx.get('webServer') !== undefined) registerRoutes(ctx)
}

/** Register the `/images` command when the command registry is composed. */
function registerCommand(ctx) {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    ctx.logger?.warn?.('[image-governor] commands 服务不可用，/images 命令未注册')
    return
  }

  const disposer = commands.register({
    name: 'images',
    description: '会话图片载荷：status 盘点 / clear 移出上下文 / restore 取回',
    handler: async (invocation) => {
      const { sub, keep, newest, confirmed } = parseArgs((invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean))
      const session = invocation.agent?.session
      if (session === undefined) return { kind: 'error', text: '[image-governor] 拿不到当前会话。' }
      try {
        if (sub === 'status') {
          const inventory = collectImageInventory(session)
          if (inventory.imageBlocks === 0) return { kind: 'success', text: formatInventory(inventory) }
          const provider = routedProvider(session)
          const plan = planImagePayload(inventory, resolveImageBound(ctx.get('settings'), provider))
          return { kind: 'success', text: (provider === undefined ? '' : `路由 ${provider}\n`) + formatInventory(inventory, plan) }
        }
        if (sub === 'clear') {
          const plan = planImageRelease(session, { keep, newest })
          if (!confirmed) return { kind: 'success', text: formatRelease(plan, false) }
          if (plan.released.length === 0) return { kind: 'success', text: formatRelease(plan, true) }
          const applied = await runMaintenance(invocation.agent, (signal) => {
            const seqs = []
            for (const item of plan.released) {
              signal?.throwIfAborted?.()
              seqs.push(session.append(item.type, item.data, item.intent).seq)
            }
            return seqs
          })
          return {
            kind: 'success',
            text: `${formatRelease(plan, true)}\n写入事件 seq：${applied.join('、')}`,
            sourceEventSeq: applied[applied.length - 1],
          }
        }
        if (sub === 'restore') {
          const { restores, skipped } = planImageRestore(session)
          if (restores.length === 0) {
            return { kind: 'success', text: '当前可见历史里没有本插件移出的图片。' }
          }
          if (!confirmed) {
            return {
              kind: 'success',
              text: `将取回 ${restores.length} 个节点的原始图片（${restores.map(item => `seq ${item.seq}←${item.originalSeq}`)
                .join('、')}），原始 ${(restores.reduce((sum, item) => sum + item.bytes, 0) / 1048576).toFixed(2)} MB 会重新计入每步上行。`
                + '\n未写入。确认无误后加 `--yes` 执行。',
            }
          }
          const applied = await runMaintenance(invocation.agent, (signal) => {
            const seqs = []
            for (const item of restores) {
              signal?.throwIfAborted?.()
              seqs.push(session.append(item.type, item.data, item.intent).seq)
            }
            return seqs
          })
          return {
            kind: 'success',
            text: `已取回 ${restores.length} 个节点的图片。`
              + (skipped.length > 0 ? `\n跳过：${skipped.map(item => `seq ${item.seq}（${item.reason}）`).join('、')}` : '')
              + `\n写入事件 seq：${applied.join('、')}`,
            sourceEventSeq: applied[applied.length - 1],
          }
        }
        return { kind: 'error', text: USAGE }
      } catch (error) {
        const message = String(error?.message ?? error)
        if (/maintenance|not idle|busy|running/i.test(message)) {
          return { kind: 'error', text: `[image-governor] 会话正在运行，不能在此时改写历史：${message}` }
        }
        return { kind: 'error', text: `[image-governor] 失败：${message}` }
      }
    },
  })
  ctx.effect(() => disposer, 'image-governor commands')
  ctx.logger?.info?.('[image-governor] 已加载：/images status · clear · restore')
}

/**
 * Run one surface rewrite only while the agent is idle, through the same
 * maintenance gate manual compaction uses: a turn-driving agent rejects it
 * synchronously, and the caller surfaces that as a retry-later message. The job
 * checks the abort signal between appends so a cancelled maintenance task
 * cannot keep writing after it loses ownership of the agent.
 */
async function runMaintenance(agent, job) {
  if (agent === undefined) throw new Error('no agent')
  if (typeof agent.runMaintenance !== 'function') throw new Error('该 agent 不支持维护任务（runMaintenance 不可用）')
  return await agent.runMaintenance(async (signal) => await job(signal))
}

/** Attachment references exactly as recorded in an event, for the store's read contract. */
function rawImageRefs(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) rawImageRefs(item, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (node.type === 'image' && typeof node.attachment === 'object' && node.attachment !== null) found.push(node.attachment)
  for (const key of Object.keys(node)) {
    if (key === 'attachment') continue
    rawImageRefs(node[key], found)
  }
  return found
}

/** The live session whose id matches, or undefined when it is not in this process. */
function findSession(ctx, sessionId) {
  if (sessionId === undefined || sessionId === '') return undefined
  const agents = ctx.get('agents')
  if (agents === undefined) return undefined
  try {
    for (const item of agents.list()) {
      const session = item?.session ?? item?.agent?.session
      if (session !== undefined && String(session.id) === sessionId) return session
    }
  } catch {
    // An agents face that refuses to enumerate is a missing session, not a failure.
  }
  return undefined
}

/** The attachment reference recorded in one session event, by id. */
function findAttachmentRef(session, attachmentId) {
  for (const event of session.events) {
    for (const ref of rawImageRefs(event.data)) {
      if (String(ref.attachmentId) === attachmentId) return ref
    }
  }
  return undefined
}

/** A prepared response, served through whichever server adapter is composed. */
function jsonResponse(body, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  }
}

/** Answer through the Node response when present, otherwise return a fetch Response. */
function send(res, prepared) {
  if (res !== undefined && typeof res.writeHead === 'function') {
    res.writeHead(prepared.status, prepared.headers)
    res.end(prepared.body)
    return undefined
  }
  return new Response(prepared.body, { status: prepared.status, headers: prepared.headers })
}

/** Owned, JSON-safe payload describing one session's image payload for the picker. */
function inventoryPayload(ctx, sessionId) {
  const session = findSession(ctx, sessionId)
  if (session === undefined) return jsonResponse({ ok: false, error: '找不到该会话（可能已关闭）' }, 404)
  const inventory = collectImageInventory(session)
  const provider = routedProvider(session)
  const capBytes = resolveImageBound(ctx.get('settings'), provider)
  const marked = annotateImageShipment(inventory, capBytes)
  return jsonResponse({
    ok: true,
    sessionId: String(session.id),
    provider: provider ?? null,
    capBytes: capBytes ?? null,
    surfaceNodes: inventory.surfaceNodes,
    historyBytes: inventory.rawBytes,
    historyBase64Bytes: inventory.base64Bytes,
    shippedBase64Bytes: marked.shippedBase64Bytes,
    offloadedImages: marked.offloadedImages,
    placeholders: planImageRestore(session).restores.length,
    images: marked.images,
  })
}

/** Read one small JSON body from whichever request object the server hands over. */
async function readJsonBody(req) {
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) throw new Error('请求体过大')
    text += decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()
  return text === '' ? {} : JSON.parse(text)
}

/** Keep only the bounded fields the client half is allowed to report. */
function sanitizeReport(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const text = (key, limit) => (typeof source[key] === 'string' ? source[key].slice(0, limit) : undefined)
  const flag = (key, nested) => {
    const holder = source[key]
    return holder !== null && typeof holder === 'object' && typeof holder[nested] === 'boolean' ? holder[nested] : undefined
  }
  const count = (key, nested) => {
    const holder = source[key]
    return holder !== null && typeof holder === 'object' && Number.isFinite(holder[nested]) ? holder[nested] : undefined
  }
  return {
    ok: source.ok === true,
    version: text('version', 24),
    href: text('href', 200),
    error: text('error', 400),
    seats: Array.isArray(source.seats)
      ? source.seats.filter(seat => typeof seat === 'string').slice(0, 8).map(seat => seat.slice(0, 64))
      : [],
    // Registered is not rendered: only these two say whether the UI reached the page.
    dom: {
      headerLabel: flag('dom', 'headerLabel'),
      cardText: flag('dom', 'cardText'),
      present: Array.isArray(source.dom?.present)
        ? source.dom.present.filter(item => typeof item === 'string').slice(0, 12).map(item => item.slice(0, 24))
        : [],
    },
    ledger: { header: count('ledger', 'header'), settings: count('ledger', 'settings') },
  }
}

/**
 * Every live session that currently carries images, for the frame-wide entry
 * point, which has no session scope of its own to read from.
 */
function sessionsPayload(ctx) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.list !== 'function') {
    return jsonResponse({ ok: false, error: 'sessions 服务不可用' }, 503)
  }
  const titles = ctx.get('sessionTitle')
  const rows = []
  for (const session of sessions.list()) {
    let inventory
    try {
      inventory = collectImageInventory(session)
    } catch {
      // A session that cannot be read yet is simply not offered.
      continue
    }
    if (inventory.imageBlocks === 0) continue
    const provider = routedProvider(session)
    const capBytes = resolveImageBound(ctx.get('settings'), provider)
    const marked = annotateImageShipment(inventory, capBytes)
    let title
    try {
      const snapshot = titles?.get?.(session)
      if (typeof snapshot?.title === 'string' && snapshot.title !== '') title = snapshot.title.slice(0, 120)
    } catch {
      // A title face that refuses to answer leaves the row untitled.
    }
    rows.push({
      sessionId: String(session.id),
      title,
      provider: provider ?? null,
      capBytes: capBytes ?? null,
      images: inventory.images.length,
      historyBytes: inventory.rawBytes,
      historyBase64Bytes: inventory.base64Bytes,
      shippedBase64Bytes: marked.shippedBase64Bytes,
      offloadedImages: marked.offloadedImages,
      placeholders: planImageRestore(session).restores.length,
    })
  }
  rows.sort((left, right) => right.historyBase64Bytes - left.historyBase64Bytes)
  return jsonResponse({ ok: true, sessions: rows })
}

/**
 * Run one slash-command line against a live session through the command
 * registry, so the frame-wide entry point shares the exact mutation path (and
 * its `command/run` · `command/done` logging) with a typed command.
 */
async function runPayload(ctx, ctxBody) {
  const commands = ctx.get('commands')
  if (commands === undefined || typeof commands.execute !== 'function') {
    return jsonResponse({ ok: false, error: 'commands 服务不可用' }, 503)
  }
  const sessionId = typeof ctxBody?.sessionId === 'string' ? ctxBody.sessionId : ''
  const line = typeof ctxBody?.line === 'string' ? ctxBody.line.slice(0, 2000) : ''
  if (!line.startsWith('/images')) return jsonResponse({ ok: false, error: '只接受 /images 命令' }, 400)
  const agents = ctx.get('agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (agent === undefined) return jsonResponse({ ok: false, error: '找不到该会话的 agent' }, 404)
  const execution = await commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) return jsonResponse({ ok: false, error: '命令未被匹配' }, 409)
  return jsonResponse({
    ok: execution.result.kind === 'success',
    kind: execution.result.kind,
    text: typeof execution.result.text === 'string' ? execution.result.text.slice(0, 4000) : undefined,
  })
}

/** Serve the read-only routes the picker needs and the one command bridge. */
function registerRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[image-governor] webServer 服务不可用，勾选界面的数据路由未注册')
    return
  }
  // Last client-half self-report, held across requests so a host-side reader can
  // tell whether the browser actually loaded and registered this plugin.
  const report = { value: null }
  const inventoryRoute = webServer.register({
    kind: 'exact',
    path: '/api/image-governor/inventory',
    handler: async (req, res) => {
      try {
        const url = new URL(req?.url ?? '/', 'http://127.0.0.1')
        return send(res, inventoryPayload(ctx, url.searchParams.get('session') ?? undefined))
      } catch (error) {
        return send(res, jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500))
      }
    },
  })
  const thumbRoute = webServer.register({
    kind: 'exact',
    path: '/api/image-governor/thumb',
    handler: async (req, res) => {
      try {
        const url = new URL(req?.url ?? '/', 'http://127.0.0.1')
        const session = findSession(ctx, url.searchParams.get('session') ?? undefined)
        if (session === undefined) return send(res, jsonResponse({ ok: false, error: '找不到该会话' }, 404))
        const attachmentId = url.searchParams.get('id') ?? ''
        const ref = findAttachmentRef(session, attachmentId)
        if (ref === undefined) return send(res, jsonResponse({ ok: false, error: '该会话里没有这个附件' }, 404))
        const store = ctx.get('attachments')
        if (store === undefined || typeof store.readImage !== 'function') {
          return send(res, jsonResponse({ ok: false, error: 'attachment 存储不可用' }, 503))
        }
        const stored = await store.readImage(ref)
        return send(res, {
          status: 200,
          headers: {
            'content-type': typeof ref.mediaType === 'string' ? ref.mediaType : 'application/octet-stream',
            // Content-addressed bytes never change under one id.
            'cache-control': 'private, max-age=31536000, immutable',
          },
          body: stored.data,
        })
      } catch (error) {
        return send(res, jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500))
      }
    },
  })
  const reportRoute = webServer.register({
    kind: 'exact',
    path: '/api/image-governor/report',
    handler: async (req, res) => {
      try {
        if (req?.method === 'POST') {
          report.value = { receivedAt: Date.now(), ...sanitizeReport(await readJsonBody(req)) }
          return send(res, jsonResponse({ ok: true }))
        }
        return send(res, jsonResponse({ ok: true, report: report.value }))
      } catch (error) {
        return send(res, jsonResponse({ ok: false, error: String(error?.message ?? error) }, 400))
      }
    },
  })
  const sessionsRoute = webServer.register({
    kind: 'exact',
    path: '/api/image-governor/sessions',
    handler: async (_req, res) => {
      try {
        return send(res, sessionsPayload(ctx))
      } catch (error) {
        return send(res, jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500))
      }
    },
  })
  const runRoute = webServer.register({
    kind: 'exact',
    path: '/api/image-governor/run',
    handler: async (req, res) => {
      try {
        return send(res, await runPayload(ctx, await readJsonBody(req)))
      } catch (error) {
        return send(res, jsonResponse({ ok: false, error: String(error?.message ?? error) }, 400))
      }
    },
  })
  // One effect per route, mirroring the command registration: the body runs at
  // registration and its RETURNED disposer is the cleanup. Calling the disposers
  // inside the body would unregister the routes the moment they were added.
  ctx.effect(() => inventoryRoute, 'image-governor inventory route')
  ctx.effect(() => thumbRoute, 'image-governor thumb route')
  ctx.effect(() => reportRoute, 'image-governor report route')
  ctx.effect(() => sessionsRoute, 'image-governor sessions route')
  ctx.effect(() => runRoute, 'image-governor run route')
  ctx.logger?.info?.('[image-governor] 路由已注册：/api/image-governor/{inventory,thumb,report,sessions,run}')
}

export function apply(ctx) {
  try {
    enable(ctx)
  } catch (error) {
    // Never rethrow: a failed fiber is reported as a boot failure by the web
    // audit, which is exactly the outcome this plugin must not cause.
    try {
      ctx.logger?.error?.('[image-governor] 降级：插件未完成注册，DSH 继续启动', error)
    } catch {
      // A logger that itself throws cannot be reported anywhere.
    }
  }
}
