# dsh-image-governor

会话图片载荷治理插件（独立包，不修改 DSH 仓库）。

## 为什么需要它

实测一条"复刻电商套图"的会话：模型可见历史里带着 **13 张图片附件、原始 11.05 MB → base64 约 14.74 MB**。图片从第 2 轮分布到第 40 轮以后，其中大多是 `tool/result` —— agent 读过或生成过、后续轮次早已不再需要的图。

该渠道上行速率实测只有 0.07–0.10 MB/s，于是每步光上传就要 100–140 秒，源站前面的网关约 150 秒返回 `524`。路由级 `maxRequestImageBytes` 能把上行压到 1.63 MB，但它是**字节预算**：保留"最新的、装得下的"，于是模型看得见最新产物，反而**看不见最初给它的产品参考图**。这个插件把这件事交回给人决定。

## v0.3.0 提供什么

| 能力 | 位置 |
| --- | --- |
| **勾选界面** | 会话标题栏的 🖼 按钮 → 缩略图网格，每张一个复选框（勾选 = 保留在模型上下文里）。底部一键"移出未勾选的 N 张（省 X MB）"与"取回全部" |
| `/images status` | 三个数分开报：历史有多少、上限之后实际每步发送多少、多少张已被降级；附每张图的 seq / turn / step / 类型 / 文件名 / 字节 |
| `/images clear [keep <seq\|文件名\|sha256id> …] [--newest N] [--yes]` | 移出模型上下文。**不加 `--yes` 只预览** |
| `/images restore [--yes]` | 取回被移出的图片 |

勾选界面的默认状态是**勾住"当前实际在发"的那几张**（保持现状），所以打开它不会突然改变模型看到的东西；要改变时才动。

## 它怎么改写模型可见历史（以及为什么只能这么做）

DSH 的出站请求是**深冻结、只读**的（`llm/stream` 的 waterfall 监听者不得改写），因为"模型可见内容必须能从会话日志重建"。所以让模型少看图**只有一条合规路径**：把变化写成日志里的事件。本插件用 `{ op: 'replace', start, end }` 的**单位置替换**协议 —— 内核文档明写该协议"Used by compaction; **any surface-replacing producer may use it**"。

- 原事件**不删除**，只是被 shadow 并留在 append-only 日志里，所以 `restore` 能取回；
- 替换只在**会话空闲**时执行，走官方手工压缩用的同一道闸门 `agent.runMaintenance`（回合进行中同步拒绝）；
- 取消信号在两次写入之间检查；
- 占位文本写明"移出了哪张、多大、原 seq、怎么取回"。它不需要像适配器的临时降级那样用常量字符串——适配器每次请求重算，常量才不打断前缀缓存；本插件的文本一次写入日志后永不再变；
- 勾选界面**不新增第二条写入通道**：它提交的就是人手工输入的那条 `/images clear … --yes`，并把宿主是否匹配到该命令如实显示出来。

## 数据路由（勾选界面用）

| 路由 | 用途 |
| --- | --- |
| `GET /api/image-governor/inventory?session=<id>` | 该会话的逐张清单：seq / turn / step / 文件名 / 字节 / base64 / **是否真的会发出去（`shipped`）**，以及上限、历史量、已移出节点数 |
| `GET /api/image-governor/thumb?session=<id>&id=<attachmentId>` | 该附件的原始字节（`attachments.readImage` 按内容寻址读取，带 immutable 缓存头） |

两条都是只读路由；`webServer` 服务缺失时只降级这两条，命令照常可用。

## 非致命挂载（本包的核心设计约束）

DSH 的 web 启动会审计每个条目：`import failed`、fiber `FAILED`、以及**停在 `PENDING`（等待不存在的服务）都算失败**，任何一条失败都会让整页不挂载（`packages/client/web/src/boot.ts` 的 `assertEntriesActive`）。因此本包：

1. **不声明 `inject`** —— 服务一律 `ctx.get('name')` 读取并处理缺失，绝不产生 PENDING；
2. **`apply` 永不外抛** —— 注册失败只写日志，fiber 保持 `ACTIVE`，DSH 照常启动；
3. **客户端半区只 `require('react')`，无静态 import、无跨包运行时取值** —— 模块求值期失败是 apply 内的 try/catch 救不回来的，而那正是拖垮启动的那一类；
4. 挂载行可随时 `disabled: true` 关闭（`cordis.patch.yml` 支持）。

## 安装

```sh
dsh plugin --profile web add F:/dsh/dsh-image-governor
```

装进 profile（写 `package.json` 依赖 + `bundles` 行）后重启与升级 DSH 仍然生效。改完客户端代码需要 `dsh plugin` 重装或运行时重载，并**硬刷新页面**才会看到新界面。

## 验证

三套离线脚本 + 两条活体检查：

```sh
node .smoke_image_governor.mjs                    # 宿主：盘点、上限计划、命令写路径、路由注册
node .smoke_image_governor_client.mjs             # 客户端：真实求值 lib/client.js + 驱动勾选组件
node --import tsx/esm .test_release_kernel.mjs    # 内核真校验器
curl 'http://127.0.0.1:3080/api/image-governor/inventory?session=<id>'
curl -o out.png 'http://127.0.0.1:3080/api/image-governor/thumb?session=<id>&id=<attachmentId>'
```

- **宿主**：真实会话 fixture 的张数 / 去重 / 字节与独立脚本一致；`clear --yes` 写出 10 次单位置替换、合成后可见历史图片数归零、`restore` 全部取回；忙 / 无 `runMaintenance` / 已取消三种情形均拒绝且不写入；两条路由注册后**不会**被自己的 effect 体误卸载，且清理只移除这两条；6 种恶意 ctx 下 `apply` 不外抛。
- **客户端**：stub 模块表后真的求值 `lib/client.js`；用最小 hooks 运行时驱动勾选组件，断言清单请求 URL、缩略图 URL、默认勾选（只勾"在发"的）、主按钮文案、**提交的命令行**，以及宿主报告 `matched: false` 时面板显示"命令没有被执行"而不是假装成功。
- **内核**：把插件构造的每个替换事件喂给 `dsh-session` 的真实 `foldSurface`。除正向通过，还有 5 条反向控制必须被拒并给出内核原始错误串（改 `turn` → `may only change content`；漏报 shadow → `must include every shadowed surface node`；`surfaceOp` 多字段 → `invalid replace surfaceOp`；替换已替换节点 → `not found in surface`；缺标记 → `requires a surfaceOp marker`）。
- **活体**：清单路由返回 200 与真实 13 张清单（上限 2,500,000、实际每步 1.63 MB）；缩略图路由返回 `image/png` 且字节数与附件记录完全一致（895,326 B）。

## 已知限制与后续工作

- **勾选面板的视觉未经浏览器实测**：组件行为有测试，但布局/定位（`position: fixed` 面板）只在真实页面里才算数。
- **`user/message` 的粘贴图**：内核的 `assertToolResultRewrite` 只约束 `tool/result`，`user/message` 走位置替换 + provenance；已有测试覆盖，真实粘贴图仍值得一次线上确认。
- **识图开关的联动坑**：把模型 `input` 改为 `['text']` 后，历史里仍有图片的会话每次请求会抛 `UNSUPPORTED_CONTENT`（适配器检查整个请求）。该开关必须与本包的降级绑定，否则等于打死会话。
- **宿主侧未做缩略图缩放**：路由返回原图字节，由浏览器缩放。本机回环 + immutable 缓存下代价可接受；如果要跨机器访问，应改为宿主侧生成缩略图。
- **命令被输入框状态吞掉**：未被认领的斜杠行会静默变成一次普通模型请求（本插件已在面板里显式报出这种情形，根治需在内核层）。
