/**
 * dsh-image-governor — browser half.
 *
 * Three additive seats, one shared picker:
 * - `shell.overlay` renders a frame-wide pill. The shell itself renders this seat,
 *   so the entry point survives any plugin that takes over the session header or
 *   body; it lists the sessions that currently carry images.
 * - `conversation.session.header.actions` adds the same picker next to the session
 *   title wherever that seat is actually rendered.
 * - `settings.plugin.item` carries the command reference card.
 *
 * The panel is deliberately non-modal: it opens above the pill, dims nothing, and
 * closes on an outside press, so picking images never hides the composer or the
 * conversation behind a backdrop.
 *
 * Selection means "move this image out of the model's context": nothing is
 * selected on open, so the panel never starts one click away from a bulk edit,
 * and every applied change can be undone from the same panel.
 *
 * Every write goes through the `/images` command: the browser posts the line to
 * the host bridge, which runs it through the command registry, so the session log
 * records the ordinary `command/run` · `command/done` pair and the plugin owns no
 * second mutation path.
 *
 * Wrapped for the client module table so `require('react')` resolves through the
 * shell's baseline externals instead of bundling a second React.
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-governor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const VERSION = '0.6.1'
    const SETTINGS_SLOT = 'settings.plugin.item'
    const HEADER_SLOT = 'conversation.session.header.actions'
    const OVERLAY_SLOT = 'shell.overlay'
    const SETTINGS_KEY = 'dsh-image-governor'
    const BUTTON_ID = 'image-governor-picker'
    const PILL_ID = 'image-governor-pill'
    const STYLE_ID = 'image-governor-style'
    const BASE = '/api/image-governor'
    const INVENTORY_URL = `${BASE}/inventory`
    const SESSIONS_URL = `${BASE}/sessions`
    const RUN_URL = `${BASE}/run`
    const THUMB_URL = `${BASE}/thumb`

    /** Theme-token styles, so the panel follows light and dark alike. */
    const CSS = `
.dsh-imgov-btn { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background: transparent;
  color: var(--dsw-alias-text-primary, inherit); font-size: 12px; cursor: pointer; }
.dsh-imgov-btn:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); }
.dsh-imgov-btn[disabled] { opacity: .55; cursor: default; }
.dsh-imgov-panel { position: fixed; right: 16px; bottom: 56px; z-index: 41; width: min(560px, 92vw);
  max-height: calc(100vh - 120px); overflow: auto; padding: 14px 16px; border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #1e1e1e));
  color: var(--dsw-alias-text-primary, inherit); box-shadow: 0 18px 60px rgba(0,0,0,.36); font-size: 13px; }
.dsh-imgov-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsh-imgov-title { font-size: 15px; font-weight: 600; }
.dsh-imgov-sub { color: var(--dsw-alias-text-secondary, inherit); line-height: 20px; margin-top: 4px; }
.dsh-imgov-presets { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
.dsh-imgov-preset { padding: 4px 10px; border-radius: 999px; font-size: 12px; cursor: pointer;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: transparent;
  color: var(--dsw-alias-text-secondary, inherit); }
.dsh-imgov-preset:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); }
.dsh-imgov-preset[disabled] { opacity: .45; cursor: default; }
.dsh-imgov-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 10px; margin: 12px 0; }
.dsh-imgov-cell { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); }
.dsh-imgov-cell.is-picked { border-color: var(--dsw-alias-brand-primary, #4c8bf5);
  background: var(--dsw-alias-bg-layer-1, rgba(76,139,245,.08)); }
.dsh-imgov-thumb { width: 100%; height: 108px; object-fit: contain; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); }
.dsh-imgov-cell input[type=checkbox] { appearance: none; -webkit-appearance: none; margin: 0;
  width: 20px; height: 20px; border-radius: 6px; cursor: pointer; position: relative; flex: none;
  border: 1.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.6));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08)); }
.dsh-imgov-cell input[type=checkbox]:hover { border-color: var(--dsw-alias-brand-primary, #4c8bf5); }
.dsh-imgov-cell input[type=checkbox]:checked { border-color: var(--dsw-alias-brand-primary, #4c8bf5);
  background: var(--dsw-alias-brand-primary, #4c8bf5); }
.dsh-imgov-cell input[type=checkbox]:checked::after { content: '✓'; position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1; color: #fff; }
.dsh-imgov-cell input[type=checkbox]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c8bf5);
  outline-offset: 2px; }
.dsh-imgov-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; }
.dsh-imgov-facts { font-size: 12px; line-height: 16px; color: var(--dsw-alias-text-secondary, inherit);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-imgov-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-imgov-dim { color: var(--dsw-alias-text-secondary, inherit); }
.dsh-imgov-badge { padding: 0 6px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); }
.dsh-imgov-badge.is-unseen { opacity: .7; border-style: dashed; }
.dsh-imgov-badge.is-picked { border-color: var(--dsw-alias-brand-primary, #4c8bf5);
  color: var(--dsw-alias-brand-primary, #4c8bf5); }
.dsh-imgov-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px;
  padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }
.dsh-imgov-primary { padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.16)); color: inherit; }
.dsh-imgov-primary[disabled] { opacity: .5; cursor: default; }
.dsh-imgov-note { color: var(--dsw-alias-text-secondary, inherit); font-size: 12px; }
.dsh-imgov-error { color: var(--dsw-alias-text-error, #e5534b); margin-top: 4px; }
.dsh-imgov-undo { display: inline-flex; align-items: center; gap: 8px; margin-top: 8px; padding: 6px 10px;
  border-radius: 8px; font-size: 12px; border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.5)); }
.dsh-imgov-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
  padding: 8px 10px; margin-top: 6px; border-radius: 8px; cursor: pointer; text-align: left;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background: transparent; color: inherit; }
.dsh-imgov-row:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); }
.dsh-imgov-code { font-family: ui-monospace, Consolas, monospace; color: var(--dsw-alias-text-secondary, inherit); }
`

    /** Inject the sheet once per document. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`
    const classNames = (...names) => names.filter(Boolean).join(' ')

    /**
     * Close on a pointer press outside the panel, which is what replaces the
     * backdrop: the rest of the app stays clickable while the panel is open.
     * @param open - whether the panel is showing.
     * @param close - the closer to invoke.
     */
    function useOutsideClose(open, close) {
      React.useEffect(() => {
        if (!open || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (typeof target?.closest !== 'function') return
          if (target.closest('.dsh-imgov-panel') !== null) return
          // The pill and the header button toggle themselves; do not fight them.
          if (target.closest('.dsh-imgov-btn') !== null) return
          close()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => document.removeEventListener('pointerdown', onPointerDown, true)
      }, [open, close])
    }

    /** One JSON request that never throws: failures come back as `{ ok: false }`. */
    async function requestJson(url, options) {
      const response = await fetch(url, options)
      const payload = await response.json().catch(() => null)
      return payload ?? { ok: false, error: `HTTP ${response.status}` }
    }

    /** Fetch one session's image payload; throws with the host's reason. */
    async function fetchInventory(sessionId) {
      const payload = await requestJson(`${INVENTORY_URL}?session=${encodeURIComponent(sessionId)}`)
      if (payload.ok !== true) throw new Error(String(payload.error ?? '读取清单失败'))
      return payload
    }

    /** Run one `/images …` line against a session through the command registry. */
    async function runImages(sessionId, line) {
      return await requestJson(RUN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, line }),
      })
    }

    /** Where one image came from, in the operator's words rather than event types. */
    function origin(image) {
      return image.type === 'user/message' ? '你粘贴的' : '模型产出的'
    }

    /** When it arrived, without inventing a turn number the log does not carry. */
    function arrived(image) {
      return image.turn === undefined ? '较早' : `第 ${image.turn} 轮`
    }

    function line(text, muted) {
      return React.createElement('div', {
        style: {
          fontSize: '12px',
          lineHeight: '18px',
          color: muted ? 'var(--dsw-alias-text-secondary, inherit)' : 'inherit',
          fontFamily: muted ? undefined : 'ui-monospace, Consolas, monospace',
          whiteSpace: 'pre-wrap',
        },
      }, text)
    }

    /**
     * One thumbnail cell. The checkbox is the action's object: checked means this
     * image will be moved out of the model's context, and the cell says so.
     */
    function cell(image, picked, sessionId, onToggle) {
      return React.createElement('label', {
        key: `${image.seq}:${image.attachmentId}`,
        className: classNames('dsh-imgov-cell', picked && 'is-picked'),
      },
        React.createElement('input', { type: 'checkbox', checked: picked, onChange: () => onToggle(image.seq) }),
        React.createElement('img', {
          className: 'dsh-imgov-thumb',
          loading: 'lazy',
          alt: image.name ?? 'image',
          src: `${THUMB_URL}?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(String(image.attachmentId))}`,
        }),
        React.createElement('div', { className: 'dsh-imgov-meta' },
          React.createElement('span', { className: 'dsh-imgov-name', title: image.name ?? '' }, image.name ?? '(未命名)')),
        React.createElement('div', { className: 'dsh-imgov-facts' },
          `${arrived(image)} · ${origin(image)} · ${mb(image.bytes)}`),
        ...(picked || !image.shipped
          ? [React.createElement('div', { className: 'dsh-imgov-meta' },
            ...(picked ? [React.createElement('span', { className: 'dsh-imgov-badge is-picked' }, '将移出')] : []),
            ...(image.shipped ? [] : [React.createElement('span', { className: 'dsh-imgov-badge is-unseen' }, '模型看不见')]))]
          : []))
    }

    /**
     * The picker panel: thumbnails, an explicit selection to move out, presets for
     * the common choices, and an undo row after every applied change.
     */
    function ImagePanel(props) {
      const sessionId = props.sessionId
      const [data, setData] = React.useState(null)
      const [picked, setPicked] = React.useState([])
      const [error, setError] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [undo, setUndo] = React.useState(null)

      const reload = React.useCallback(async () => {
        try {
          const payload = await fetchInventory(sessionId)
          setData(payload)
          // Nothing is selected on load: the panel never starts one click away
          // from a bulk edit, and an empty selection cannot write anything.
          setPicked([])
        } catch (reason) {
          setError(String(reason?.message ?? reason))
        }
      }, [sessionId])

      React.useEffect(() => { void reload() }, [reload])

      const apply = React.useCallback(async (commandLine, onSuccess) => {
        setBusy(true)
        setStatus(null)
        setError(null)
        try {
          const payload = await runImages(sessionId, commandLine)
          if (payload.ok === true) {
            setStatus(typeof payload.text === 'string' ? payload.text : '完成')
            setUndo(onSuccess)
            await reload()
          } else {
            setError(`${String(payload.text ?? payload.error ?? '命令未执行')}\n（命令：${commandLine}）`)
          }
        } catch (reason) {
          setError(String(reason?.message ?? reason))
        } finally {
          setBusy(false)
        }
      }, [sessionId, reload])

      const images = data?.images ?? []
      const pickedSet = new Set(picked)
      const toggle = (seq) => setPicked(current => current.includes(seq)
        ? current.filter(value => value !== seq)
        : [...current, seq])
      const chosen = images.filter(image => pickedSet.has(image.seq))
      const freedBase64 = chosen.reduce((sum, image) => sum + image.base64Bytes, 0)
      const unseen = images.filter(image => !image.shipped)
      const newest = images.length === 0 ? undefined : images[images.length - 1]

      /** The command keeps everything that is NOT selected, so selection stays the action. */
      const moveOut = async () => {
        const keep = images.filter(image => !pickedSet.has(image.seq)).map(image => image.seq)
        const commandLine = keep.length > 0 ? `/images clear keep ${keep.join(' ')} --yes` : '/images clear --yes'
        await apply(commandLine, { label: `已移出 ${chosen.length} 张` })
      }

      return React.createElement('div', { className: 'dsh-imgov-panel' },
        React.createElement('div', { className: 'dsh-imgov-head' },
          React.createElement('span', { className: 'dsh-imgov-title' }, '会话图片'),
          React.createElement('button', { type: 'button', className: 'dsh-imgov-btn', onClick: props.onClose }, '关闭')),
        React.createElement('div', { className: 'dsh-imgov-sub' },
          data === null
            ? '正在读取…'
            : `这个会话的历史里有 ${images.length} 张图（${mb(data.historyBytes)}）。`
              + `模型现在能看到 ${images.length - unseen.length} 张`
              + (unseen.length > 0 ? `，另外 ${unseen.length} 张已经看不见（被当前渠道的图片上限降级）` : '')
              + '。勾选要移出上下文的图片，没勾的保持原样。'),
        ...(error === null ? [] : [React.createElement('div', { className: 'dsh-imgov-error' }, error)]),
        ...(status === null ? [] : [React.createElement('div', { className: 'dsh-imgov-sub' }, status)]),
        ...(undo === null ? [] : [React.createElement('div', { className: 'dsh-imgov-undo' },
          React.createElement('span', null, undo.label),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-imgov-btn',
            disabled: busy,
            onClick: () => apply('/images restore --yes', null),
          }, '撤销'))]),
        images.length === 0
          ? React.createElement('div', { className: 'dsh-imgov-sub' }, '这个会话的可见历史里没有图片。')
          : React.createElement('div', null,
            React.createElement('div', { className: 'dsh-imgov-presets' },
              React.createElement('button', {
                type: 'button',
                className: 'dsh-imgov-preset',
                disabled: busy || newest === undefined || images.length <= 1,
                onClick: () => setPicked(images.filter(image => image.seq !== newest?.seq).map(image => image.seq)),
              }, `只留最新 1 张（选中 ${Math.max(images.length - 1, 0)} 张）`),
              ...(unseen.length === 0 ? [] : [React.createElement('button', {
                type: 'button',
                className: 'dsh-imgov-preset',
                disabled: busy,
                onClick: () => setPicked(unseen.map(image => image.seq)),
              }, `只选模型已看不见的（${unseen.length} 张）`)]),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-imgov-preset',
                disabled: busy || images.length === 0,
                onClick: () => setPicked(images.map(image => image.seq)),
              }, '全选'),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-imgov-preset',
                disabled: busy || picked.length === 0,
                onClick: () => setPicked([]),
              }, '清空选择')),
            React.createElement('div', { className: 'dsh-imgov-grid' },
              images.map(image => cell(image, pickedSet.has(image.seq), sessionId, toggle)))),
        React.createElement('div', { className: 'dsh-imgov-foot' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-imgov-primary',
            disabled: busy || chosen.length === 0,
            onClick: moveOut,
          }, busy ? '执行中…' : chosen.length === 0
            ? '移出所选（先勾选图片）'
            : `移出所选的 ${chosen.length} 张（每步少发 ${mb(freedBase64)}）`),
          React.createElement('span', { className: 'dsh-imgov-note' },
            '写入只在会话空闲时生效；出错会原样报出来，写完可以撤销。')))
    }

    /**
     * Frame-wide entry: rendered by the shell itself, so it works no matter which
     * plugin occupies the session header or body. With no session scope it lists
     * the sessions that carry images and opens the shared panel for the chosen one.
     */
    function FramePill() {
      const [open, setOpen] = React.useState(false)
      const [sessions, setSessions] = React.useState(null)
      const [picked, setPicked] = React.useState(null)
      const [error, setError] = React.useState(null)

      const close = React.useCallback(() => { setOpen(false); setPicked(null) }, [])
      useOutsideClose(open, close)

      const loadSessions = React.useCallback(async () => {
        try {
          const payload = await requestJson(SESSIONS_URL)
          if (payload.ok !== true) throw new Error(String(payload.error ?? '读取会话列表失败'))
          setSessions(payload.sessions ?? [])
          setError(null)
        } catch (reason) {
          setError(String(reason?.message ?? reason))
        }
      }, [])

      React.useEffect(() => {
        if (open && picked === null) void loadSessions()
      }, [open, picked, loadSessions])

      const pill = React.createElement('button', {
        type: 'button',
        className: 'dsh-imgov-btn',
        style: { position: 'fixed', right: '16px', bottom: '16px', zIndex: 30 },
        onClick: () => (open ? close() : setOpen(true)),
        title: '会话图片治理',
      }, '🖼 图片治理')

      if (!open) return pill
      if (picked !== null) {
        return React.createElement('span', null, pill,
          React.createElement(ImagePanel, { sessionId: picked.sessionId, onClose: () => setPicked(null) }))
      }
      return React.createElement('span', null, pill,
        React.createElement('div', { className: 'dsh-imgov-panel' },
          React.createElement('div', { className: 'dsh-imgov-head' },
            React.createElement('span', { className: 'dsh-imgov-title' }, `会话图片治理 · v${VERSION}`),
            React.createElement('button', { type: 'button', className: 'dsh-imgov-btn', onClick: close }, '关闭')),
          ...(error === null ? [] : [React.createElement('div', { className: 'dsh-imgov-error' }, error)]),
          sessions === null
            ? React.createElement('div', { className: 'dsh-imgov-sub' }, '正在查找带图片的会话…')
            : sessions.length === 0
              ? React.createElement('div', { className: 'dsh-imgov-sub' }, '当前没有会话在带着图片。')
              : React.createElement('div', null,
                React.createElement('div', { className: 'dsh-imgov-sub' }, '这些会话的历史里带着图片，点一个来挑选：'),
                sessions.map(row => React.createElement('button', {
                  key: row.sessionId,
                  type: 'button',
                  className: 'dsh-imgov-row',
                  onClick: () => setPicked(row),
                },
                  React.createElement('span', null, row.title ?? `${row.sessionId.slice(0, 20)}…`),
                  React.createElement('span', { className: 'dsh-imgov-dim' },
                    `${row.images} 张 · ${mb(row.historyBytes)} · 模型看到 ${row.images - row.offloadedImages} 张`)))),
          React.createElement('div', { className: 'dsh-imgov-sub' },
            React.createElement('span', { className: 'dsh-imgov-code' }, '/images status · clear [keep …] [--yes] · restore'))))
    }

    /** The same picker, next to the session title wherever that seat is rendered. */
    function ImagePicker(props) {
      const [open, setOpen] = React.useState(false)
      const close = React.useCallback(() => setOpen(false), [])
      useOutsideClose(open, close)
      const button = React.createElement('button', {
        type: 'button',
        className: 'dsh-imgov-btn',
        disabled: props.sessionId === undefined,
        onClick: () => setOpen(value => !value),
        title: '挑选要移出模型上下文的图片',
      }, '🖼 图片')
      if (!open) return button
      return React.createElement('span', null, button,
        React.createElement(ImagePanel, { sessionId: props.sessionId, onClose: close }))
    }

    /** The command reference card. */
    function Card() {
      return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '2px 0' },
      },
        React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } },
          `图片载荷治理 · v${VERSION} · 已加载`),
        line('右下角的「🖼 图片治理」浮层列出所有带图的会话，点进去勾选要移出上下文的图片。', true),
        line('/images status', false),
        line('盘点模型可见历史里的图片：历史有多少、哪些模型已经看不见、每步实际发多少。', true),
        line('/images clear [keep <seq|文件名> …] [--newest N] [--yes]', false),
        line('把选中的图片移出模型上下文。不加 --yes 只预览；只在会话空闲时执行；可 restore 撤销。', true),
        line('/images restore [--yes]', false),
        line('取回被移出的图片。原图始终留在日志里，清除不删数据。', true))
    }

    /**
     * Report this half's activation to the host, so "the UI is missing" can be
     * answered from the host instead of from a browser console.
     */
    function report(payload) {
      try {
        void fetch(`${BASE}/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {
        // A missing fetch or a blocked request is not this plugin's problem.
      }
    }

    /** What the ledger holds for each seat, from inside the client half. */
    function seatLedger(slots, names) {
      const count = (name) => {
        try {
          return typeof slots.entries === 'function' ? slots.entries(name).length : -1
        } catch {
          return -2
        }
      }
      const out = {}
      for (const name of names) out[name] = count(name)
      return out
    }

    /** Whether this plugin's UI reached the live document, plus a shell fingerprint. */
    function probeDom() {
      try {
        const text = typeof document === 'undefined' ? '' : (document.body?.textContent ?? '')
        const needles = ['🖼 图片治理', '图片载荷治理', '任务', '发送', '设置']
        return { pill: text.includes('🖼 图片治理'), present: needles.filter(needle => text.includes(needle)) }
      } catch {
        return { pill: false, present: [] }
      }
    }

    // No hard dependency declaration: an unresolvable service would leave this
    // fiber PENDING, which the boot audit counts as a failure.
    exports.inject = []

    exports.apply = (ctx) => {
      const seats = []
      let failure
      const slots = (() => {
        try {
          return ctx.get('slots')
        } catch {
          return undefined
        }
      })()
      const payload = () => ({
        ok: failure === undefined && seats.filter(seat => seat.endsWith('#registered')).length === 3,
        version: VERSION,
        seats: [...seats],
        error: failure,
        href: typeof location === 'undefined' ? undefined : location.pathname,
        dom: probeDom(),
        ledger: slots === undefined ? undefined : seatLedger(slots, [HEADER_SLOT, SETTINGS_SLOT, OVERLAY_SLOT]),
      })
      try {
        ensureStyle()
        if (slots === undefined) {
          failure = 'slots 服务不可用（客户端界面未注册）'
        } else {
          const arm = (slot, options, Component) => {
            seats.push(slot)
            ctx.effect(() => slots.inject(slot, () => {
              try {
                const disposer = slots.register(options, Component)
                seats.push(`${slot}#registered`)
                return disposer
              } catch (error) {
                // A refused registration must not take the client boot down.
                seats.push(`${slot}#failed`)
                failure = `${slot}: ${String(error?.message ?? error)}`
                return undefined
              }
            }), `image-governor ${slot}`)
          }
          arm(OVERLAY_SLOT, { name: OVERLAY_SLOT, id: PILL_ID, order: 60 }, FramePill)
          arm(HEADER_SLOT, { name: HEADER_SLOT, id: BUTTON_ID, order: 20 }, ImagePicker)
          arm(SETTINGS_SLOT, { name: SETTINGS_SLOT, key: SETTINGS_KEY }, Card)
        }
      } catch (error) {
        failure = String(error?.message ?? error)
        try {
          ctx.logger?.error?.('[image-governor] 客户端降级：界面未注册', error)
        } catch {
          // A logger that itself throws cannot be reported anywhere.
        }
      }
      report(payload())
      // The shell mounts after activation, so only a later probe can see the DOM.
      for (const delay of [1500, 5000]) {
        try {
          setTimeout(() => report(payload()), delay)
        } catch {
          // A host without timers simply reports once.
        }
      }
    }

    return module.exports
  },
})
