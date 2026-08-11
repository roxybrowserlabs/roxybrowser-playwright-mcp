可以，过滤后和我们这个 repo 真正相关的大概是这些。

当前策略：只继续推进已经开工但还没有完全收口的功能线；完全未开始的新项先不实现，只在这里标记。

| 优先级 | 状态 | Playwright 变化 | 为什么和我们相关 |
|---|---|---|---|
| 高 | 已完成 | MCP 正式进入 `npx playwright mcp` / `npx playwright cli` | 这是我们 MCP parity 的直接对标对象，1.62.1 已经纳入新的比较基准 |
| 高 | 已完成 | MCP 新增/调整：`browser_find`、screenshot `scale`、CLI `--hires`、`--mobile` / `--device`、非 2xx navigation status、heartbeat timeout、post-action settle delay | 都已落在本地 MCP surface / 稳定性测试里 |
| 高 | 已完成 | MCP 修复：init page 前截图等待、tracing stop 状态检查、console secret redaction、data URL payload 隐藏、failed request 去重、download 明确标识 | 工具输出、隐私、安全和并行运行稳定性都已对齐 |
| 高 | 已完成 | 输入相关：新增 `bidiInsertText.ts`，BiDi `RawKeyboard.sendText()` 重做 | 已用于 BiDi insertText 和大文本拟人化分流 |
| 高 | 已完成 | Actions 新增 `scroll: "auto" | "none"` | 相关 action 选项已对齐 |
| 高 | 已完成 | `AbortSignal` 支持扩到大多数 action / wait / navigation / assertion | 已补 `Page` / `Frame` / `Locator` / `ElementHandle` / `Worker` / `BrowserContext.waitForEvent` 的支持面，并复查了 action/runtime 等待路径 |
| 中 | 已完成 | `locator.waitForFunction()` | 本地已补齐 |
| 中 | 已完成 | `page.evaluate()` 支持 function 作为参数，`addInitScript()` / `context.addInitScript()` 支持 function argument | 本地 evaluate / init script 参数序列化已对齐 |
| 中 | 已完成 | `page.screenshot()` / `locator.screenshot()` 支持 WebP、quality 语义 | 本地截图与 MCP screenshot tool 已对齐 |
| 中 | 已完成 | `APIResponse.timing()` | 本地已补齐 |
| 中 | 已完成 | ARIA snapshot distill 和 1.62.1 ARIA 修复 | vendored snapshot/injected source 已对齐 |
| 中 | 未开始，先不做 | 浏览器版本更新：Chromium 151、Firefox 153、WebKit 26.5 | 会影响 CDP/BiDi 协议细节、输入、截图、权限和稳定性 |
| 低 | 未开始，先不做 | headless clipboard 和 OS clipboard 隔离 | 如果我们做 clipboard 相关工具或测试，才需要跟 |
| 低 | 未开始，先不做 | `storageState({ credentials: true })` 保存 WebAuthn credentials | 目前除非我们实现/对齐 passkey/WebAuthn，否则可以先放后面 |

## 这次只完成了一半的

| 项 | 现在状态 | 还差什么 |
|---|---|---|
| MCP tool parity 总线 | 部分完成 | `browser_find`、screenshot/heartbeat/status/settle 这些已对齐，但整块仍以 parity 测试为主，没把所有 1.62.1 tool 变更一口气重做成“版本锁定式”实现 |
| `MCP 正式进入 npx playwright mcp / cli` | 部分完成 | 我们已经用 Playwright MCP 做了更严格的对照，但仓库里还没有把所有 CLI / inspector 的文案和入口完全重命名到“1.62.1 基线” |
| `APIResponse.timing()` | 部分完成 | API surface 已补，但网络/trace/文档侧还可以再补一轮说明 |
| ARIA snapshot 相关 | 部分完成 | vendored 源已经对齐，但 1.62.1 具体 snapshot 回归样本还可以再补更密的对照测试 |

基本可以先忽略：

| Playwright 变化 | 原因 |
|---|---|
| 新 component testing stories/galleries model | 我们不是 Playwright Test component testing runner |
| `Reporter.preprocess()` / `TestRun` | Test runner reporter API，和 browser automation/MCP 主线不近 |
| `retryStrategy: "isolated"` | Playwright Test runner 调度策略，非我们 runtime/MCP 核心 |
| HTML reporter `mergeFiles` option | 报告 UI 功能 |
| Debian 11 不支持 | 运行环境提醒，除非我们的 CI/发布镜像还依赖 Debian 11 |
| 多语言 release notes 更新 | docs-only |

我建议接下来重点看四块：`MCP tool parity`、`input/BiDi insertText`、`action scroll + AbortSignal`、`ARIA snapshot vendor regenerate`。这四块和我们当前 agent 浏览器操作稳定性最贴。

## AbortSignal 补充审计

对照 `library/playwright/packages/playwright-core/types/types.d.ts` 和 client 源码后，本轮只继续推进已经开工但漏掉的 AbortSignal 面：

| Surface | 状态 | 说明 |
|---|---|---|
| `WebSocket.waitForEvent` | 已补齐 | 四个 upstream overload 都包含 `signal`；本地类型和等待中/预取消行为已对齐 |
| `Route.fetch` | 已补齐 | page route 和 browser-context route 两条 fetch 路径都会把外部 signal 并入内部 timeout controller |
| `APIRequestContext.delete/fetch/get/head/patch/post/put` | 已补齐 | 公开签名按 upstream 1.62.1 展开，运行时 signal 会传到底层 fetch |
| `Route.fallback` | 无需补 | 复查 upstream 1.62.1 后确认没有 `signal` 参数 |
| `BrowserContext.waitForEvent` | 已补行为，签名保持本地支持事件形态 | 本地只公开已支持事件；upstream 里额外的 `backgroundpage` / `pageclose` / `pageload` / `weberror` 不属于当前支持面，不当作未完成项 |
| `Locator` action/evaluate 运行时等待 | 已补齐 | `locator.evaluate/evaluateHandle`、`click/dblclick/check/hover/fill/type/press/tap/uncheck`、`selectOption/screenshot/drop/scrollIntoViewIfNeeded/selectText/setInputFiles` 的 adapter 或 handle promise 会被外层 `signal` 打断，和 Playwright channel send 的 abort listener 语义对齐 |
| `Frame` / `Page` action 转发等待 | 已补齐 | `Frame.waitForSelector` 轮询、Frame selector action、Page action 转发、`page.waitForSelector` 都加了外层 abort race，避免 public API 卡在下层 pending promise |
| `ElementHandle.selectOption` option handle 归一化 | 已补齐 | option 是 `ElementHandle` 时，中间 evaluate 归一化也会被 `signal` 打断 |
