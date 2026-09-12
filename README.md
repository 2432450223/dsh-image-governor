# dsh-image-governor

A session image payload governor for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it audits the images a session still ships to the model, lets you pick which ones to keep, and moves the rest out of the model's context.

[English](#english) · [中文](#中文)

## English

### The problem it solves

A session's visible history can accumulate image attachments that are no longer needed: images a tool produced, screenshots the agent read, files pasted many turns ago. Every step of that session re-uploads them. In one measured session 13 attachments (11.05 MB, ≈14.7 MB as base64) rode along on every request; at the observed 0.07–0.10 MB/s upload rate that alone costs 100–140 seconds per step, and the gateway in front of the endpoint gave up at roughly 150 seconds.

A route-level `maxRequestImageBytes` bound fixes the payload, but it is a byte budget: it keeps whatever fits, which is usually the newest images. That can hide exactly the image a task depends on — the original reference, while the newest output stays visible.

This plugin puts that choice back in your hands, per session.

### What it adds

- **A picker** in the frame-wide overlay (bottom-right pill, `shell.overlay`) listing the sessions that carry images. The same picker also registers next to the session title where that seat is rendered.
- **Selection means "move out"**: nothing is selected when the panel opens, so it never starts one click away from a bulk edit. Checkboxes are the action's object; presets cover the common choices (keep only the newest, select what the model already cannot see, all, none).
- **`/images status`** — history size, what the route actually ships per step, and which images the bound already made invisible.
- **`/images clear [keep <seq|name|id> …] [--newest N] [--yes]`** — moves the chosen images out of the model context. Without `--yes` it only previews.
- **`/images restore [--yes]`** — puts them back.
- **Undo**: after every applied change the panel offers an undo, which runs the restore.

### How it writes, and what it never touches

An outgoing request is deep-frozen and must be reconstructable from the session log, so a plugin cannot rewrite it. This plugin changes what the model sees the only way the session format allows: it appends a positional surface replacement (`{ op: 'replace', start, end }`) per affected node, replacing each image block with a text placeholder that names what was removed.

- The kernel documents that protocol as `Used by compaction; any surface-replacing producer may use it`.
- The **original events stay in the append-only log**, shadowed but present, which is what makes `restore` possible.
- **No attachment is deleted.** The attachment service exposes no delete operation at all, and this plugin never writes to it.
- Writes run only while the agent is idle, through the same maintenance gate manual compaction uses; a running turn rejects them.
- The picker owns no second mutation path: it posts the same `/images … --yes` line a human would type, through the command registry, so the session log records the ordinary `command/run` · `command/done` pair.

### Install

```sh
dsh plugin --profile web add github:2432450223/dsh-image-governor
```

The package is plain JavaScript with no dependencies and no build step, so installing from the repository needs no build approval. A local checkout works the same way:

```sh
dsh plugin --profile web add /path/to/dsh-image-governor
```

### Verification

```sh
npm test                     # client + host suites
DSH_CHECKOUT=/path/to/deepseek-harness npm test   # also runs the kernel suite
```

- `test/client.smoke.mjs` evaluates the real browser bundle the way the module table does — stub loader, baseline-only `require`, hostile contexts — then drives the picker through a minimal hooks runtime and asserts the submitted command lines, the wording, and the undo path.
- `test/host.smoke.mjs` builds synthetic surface events with the same structure and aggregate sizes as a real image-heavy session (no real conversation is shipped) and covers the inventory, the payload plan, the write path, refusals, and the HTTP routes.
- `test/kernel.release.mjs` feeds every append the plugin builds through `dsh-session`'s real `foldSurface` validator, plus negative controls that must be rejected with the kernel's own error strings.

### Known limitations

- The plugin mounts no hard dependency: every service is read through `ctx.get`, and a missing one only degrades the affected surface instead of blocking a boot. When another plugin takes over the whole session header, the header button is not rendered — the frame-wide pill is the entry point that survives that.
- Thumbnails are served at the stored size; the browser scales them.
- Clearing affects the model's view only. Nothing on disk changes, and restores are always possible.
- Writes require an idle session: a running turn refuses them by design.

## 中文

### 它解决什么

一个会话的可见历史里会积累不再需要的图片附件：工具产出的图、agent 读过的截图、很多轮以前粘贴的文件。而**每一步都会把它们重新上传一遍**。实测某会话带着 13 张附件（11.05 MB，base64 约 14.7 MB）随每一步上行；在实测 0.07–0.10 MB/s 的上行速率下，仅这一项每步就要 100–140 秒，而源站前面的网关约 150 秒就会放弃。

路由级的 `maxRequestImageBytes` 上限能压住载荷，但它是**按字节预算**：谁装得下就留谁，通常留下的是最新那几张。这恰好可能把任务真正依赖的图挡掉——原始参考图看不见，而最新产物还在。

本插件把这个选择权交回给你，而且是**按会话**的。

### 它提供什么

- **勾选界面**：右下角整屏浮层里的 pill 会列出**带图片的会话**；同一个面板也会注册到会话标题旁（该 seat 被渲染时）。
- **勾选 = 移出**：面板打开时一张都不勾，因此永远不会"离批量修改只差一次点击"。复选框就是操作对象；预设覆盖常见选择（只留最新一张、只选模型已看不见的、全选、清空）。
- **`/images status`** —— 历史有多大、该路由每步实际发多少、哪些图已经被上限变成"看不见"。
- **`/images clear [keep <seq|文件名|id> …] [--newest N] [--yes]`** —— 把选中的图片移出模型上下文；不加 `--yes` 只预览。
- **`/images restore [--yes]`** —— 取回来。
- **可撤销**：每次写入后面板都给出撤销入口（走 restore）。

### 它怎么改，以及它绝不碰什么

出站请求是深冻结的、且必须能从会话日志重建，所以插件不能改写它。本插件只用会话格式允许的方式改变模型所见：对每个受影响的节点追加一条**位置替换**（`{ op: 'replace', start, end }`），把图块换成写明"移出了哪张"的文本占位符。

- 内核文档对该协议的原文是 `Used by compaction; any surface-replacing producer may use it`。
- **原事件仍留在 append-only 日志里**（被 shadow 但未删除），这正是 `restore` 成立的原因。
- **不删除任何附件**：附件服务本身就没有删除操作，本插件也从不写它。
- 写入只在 **agent 空闲**时执行，走官方手工压缩用的同一道闸门；回合进行中会被拒绝。
- 勾选界面**不新增第二条改动通道**：它提交的就是人手工会输入的那条 `/images … --yes`，经命令注册表执行，日志照常记录 `command/run` · `command/done`。

### 安装

```sh
dsh plugin --profile web add github:2432450223/dsh-image-governor
```

纯 JavaScript、零依赖、无构建步骤，因此从仓库安装**不需要任何构建授权**。本地目录同理。

### 验证

```sh
npm test
DSH_CHECKOUT=/path/to/deepseek-harness npm test   # 额外跑内核校验器
```

三套：客户端（真实求值浏览器 bundle + 驱动勾选面板）、宿主（合成 fixture，绝不含任何真实会话内容）、内核（把插件构造的每条写入喂给 `dsh-session` 真实的 `foldSurface`，并含必须被拒的反向控制）。

### 已知限制

- 不声明任何硬依赖：服务一律 `ctx.get` 读取，缺一个只会降级对应能力，不会阻塞启动。当一个插件接管了整个会话标题栏时，标题栏按钮不会被渲染——右下角 pill 是这种情况下仍然可用的入口。
- 缩略图按存储原尺寸下发，由浏览器缩放。
- 清除只影响模型的视野：磁盘上什么都没变，随时可以取回。
- 写入需要会话来空闲：正在跑的回合会被按设计拒绝。
