# Firefox / WebDriver BiDi 5 个已知问题 — 最小复现脚本

这一组脚本用**裸 BiDi WebSocket**（不经过本项目的任何适配器封装）直接对 Firefox/geckodriver 发送 WebDriver BiDi 命令，目的是把问题压缩到协议层，方便向内核工程师（Firefox Remote Protocol / geckodriver / W3C BiDi 工作组）报告，排除适配器干扰。

> 前置：`.env` 里有 `ROXYBROWSER_API_TOKEN`（与 `test:mcp-parity` 一致）。脚本会自动拉起一个 RoxyBrowser Firefox 并建裸 BiDi 连接。

## 运行

```bash
node examples/repro/bidi/01-click-alert-blocks.mjs
node examples/repro/bidi/02-handleuserprompt-hang.mjs
node examples/repro/bidi/03-listener-order-drops-events.mjs
node examples/repro/bidi/04-post-body-missing.mjs
node examples/repro/bidi/05-network-state-race.mjs
```

每个脚本都是独立入口，`_bidi-harness.mjs` 是共享的连接/夹具工具。每个脚本输出标记 `[REPRO]` 的行即为复现命中。

## 5 个问题及官方文档对照（含真实复现结果）

> 重要：下面标注了每个脚本在**当前 Firefox 146 + geckodriver** 上的真实复现结果——
> 哪些“复现命中”（✅）、哪些在裸协议层“未复现 / 难复现”（⚠️）以及原因。
> 这正是给内核工程师最有价值的部分：区分“协议/驱动缺陷” vs “本适配器读取时机问题”。

### #1 ✅ 已复现：点击触发 `alert()` 后 `input.performActions` 永不返回
- **现象**：对 `onclick=alert()` 按钮做 `input.performActions`，pointerUp 那一刻弹同步 alert，命令永不返回（超时 20s 仍未返回），且 `userPromptOpened` 事件个数为 0（命令卡死连事件都收不到）。
- **官方文档**：W3C WebDriver BiDi 规范**未规定** `performActions` 在 user prompt 打开时的行为，只规定会发 `userPromptOpened` 事件。Firefox/geckodriver 选择“阻塞 performActions 直至 modal 被处理”，规范无此约束——**建议推动规范明确此场景**。
- **对照 CDP**：CDP 只阻塞 `Input.dispatchMouseEvent` 释放那一步，客户端可 race dialog waiter；BiDi 把整段指针序列做成一个原子命令，无法中途 race。
- **佐证**：Playwright BiDi (`bidiPage._onUserPromptOpened`) 只在 `dialogDidOpen` 回调里发 `handleUserPrompt`，未在 performActions 层 race。
- **本项目缓解**：`connectedBrowser.ts` BiDi click 用 `Promise.race([performActions, waitForDialog])`，performPromise 仍 dangling。
- **脚本**：`01-click-alert-blocks.mjs` —— 输出 `[REPRO] TIMEOUT after 20000ms … 事件个数: 0`。

### #2 ⚠️ 与 #1 同根，难独立复现：modal 打开期间 `handleUserPrompt` / 后续命令卡死
- **现象（项目侧）**：modal 打开期间 `handleUserPrompt` 长时间不返回（60s+），连 `getTree` 也被卡死。
- **真实复现结果**：裸协议层用 `setTimeout(()=>alert())` 注入 modal 较难独立复现——因为同步 `alert()` 会阻塞“注入它的那次 `script.callFunction` 响应”本身，等它返回时 modal 已被关掉，于是 `handleUserPrompt` 反而很快返回。**根因与 #1 同源**（Firefox 在 JS 同步 modal 期间阻塞 BiDi 命令派发），#1 是更干净的复现。
- **官方文档**：规范未规定 modal 仍开着时 `handleUserPrompt` 是否会阻塞；Firefox 实现选择阻塞。
- **佐证**：Playwright `DialogManager.dialogDidOpen` 里有 `if (!hasHandlers) dialog._close()` —— 没有用户 handler 时立即自动关闭 dialog，正是为规避“modal 一直开着把后续命令全卡死”。这侧面证明该阻塞是真实工程痛点。
- **本项目缓解**：`handleDialog` 用 `withBiDiTimeout(…, 5000)` 快速失败。
- **脚本**：`02-handleuserprompt-hang.mjs` —— 输出 `inject call returned / handleUserPrompt returned`，附带诊断说明。

### #3 ⚠️ 未在本次命中（非确定性，时序窗口极小）：`session.subscribe` 后、监听器就位前到达的事件被丢弃
- **现象（项目侧调试）**：把 `sessionSubscribe` 放在 `attachListeners` 之前时，调试日志连续几十个 `[DEBUG bidi client no-listener] network.beforeRequestSent` —— 订阅刚成功、监听器未注册时 Firefox 已推送的事件被丢弃。
- **真实复现结果**：本脚本对比“先 attach 监听器再 subscribe” vs “先 subscribe 再 attach”，两种顺序都捕获 4/4 图片请求，**本次未命中丢失**。这是协议层“事件 fire-and-forget、无重放”导致的客户端竞态，时序窗口极小，受机器调度影响，非确定性。
- **官方文档**：规范规定事件**仅对订阅时刻起发送，且不重放**；未规定 subscribe 响应到达前是否可能已开始投递。建议 spec 增加非_normative_ 提示：“客户端应先注册监听器再 subscribe”。
- **本项目修复**：`initialize()` 已改为先 `attachBiDiListeners()` 再 `sessionSubscribe()`（更安全的写法，应保留）。
- **脚本**：`03-listener-order-drops-events.mjs` —— 在不同机器/负载下尝试命中。

### #4 ✅ 已复现 & 发现新事实：`beforeRequestSent` 不含 body，且 **geckodriver 未实现 `network.getRequestPostData`**
- **真实复现结果**：`beforeRequestSent` 事件的 `request` 字段为 `request,url,method,bodySize,headersSize,headers,cookies,destination,initiatorType,timings`——**只有 `bodySize`（数值），没有 body 内容**。随后发 `network.getRequestPostData`，geckodriver 返回 **`unknown command: network.getRequestPostData`** —— 即 **geckodriver 根本没实现这条命令**。因此当前 Firefox/BiDi 无法获取 POST 请求体。
- **官方文档**：spec 明确 `beforeRequestSent` **不内联** body；body 应由 `network.getRequestPostData` 单独获取（spec Network 模块定义了该命令）。**geckodriver 未实现是确凿的驱动缺陷**，强烈建议上报。
- **佐证**：Playwright `bidiNetworkManager._onBeforeRequestSent` 也只取 headers/url，不直接读 body（response body 走 `network.getData`）。
- **本项目缺口**：BiDi `handleBeforeRequestSent` 只置空串占位，未调 `getRequestPostData`（即使调了也拿不到，见上）。
- **脚本**：`04-post-body-missing.mjs` —— 输出 `unknown command: network.getRequestPostData`。

### #5 ⚠️ 协议层稳定，抖动在适配器侧：网络事件读取竞态
- **项目侧现象**：点击触发 `fetch('/api')` 后连续罗列网络请求，/api 的“存在性 / status 有无”偶发抖动，无法强一致断言（`=> [200] OK` 全匹配）。
- **真实复现结果**：裸协议层 + 按 `requestId` 去重，连续 8 次快照里 /api **始终存在、status 始终为 200，未抖动**。说明 BiDi 协议层在正确去重下是稳定的；项目侧抖动来自 adapter 内部“`waitForNetworkRequest` 在 `beforeRequestSent` 已到、`responseCompleted` 未到时即匹配返回，随后读取到无 status 的瞬态”——**是 adapter 读取时机问题，非协议固有缺陷**。
- **官方文档**：规范允许 `beforeRequestSent`/`responseCompleted` 各自独立投递、不保证顺序与原子性；客户端需按 `requestId` 去重并容忍中间态。
- **本项目缓解**：按 requestId 去重，status 缺失窗口由调用方容忍；未做强一致断言。
- **脚本**：`05-network-state-race.mjs` —— 用以“证伪抖动是协议层固有的”。输出 8 次稳定快照。

## 文档出处
- W3C WebDriver BiDi 规范：https://www.w3.org/TR/webdriver-bidi/ （`browsingContext.handleUserPrompt`、`browsingContext.userPromptOpened`、`network.beforeRequestSent`、`network.getRequestPostData`、`input.performActions`、`session.subscribe` 各节）
- 规范讨论 issue 库：https://github.com/w3c/webdriver-bidi/issues
- geckodriver issues：https://github.com/mozilla/geckodriver/issues
- Firefox Remote Protocol (Bugzilla 组件 `Testing` / `Marionette` / `Remote Protocol`)

## 给内核工程师的要点
1. #1/#2 的根因可能同源：Firefox 在 JS 同步 modal 打开期间，会阻塞 geckodriver 的 BiDi 命令派发线程。建议确认这是 spec 允许的实现选择还是规范未覆盖的行为，并推动规范明确“modal 打开时正在处理的 BiDi 命令应如何表现”。
2. #3 是规范的“事件不重放”设计 + Firefox“subscribe 后立即推送”的时序共同导致的客户端竞态；建议 spec 增加非_normative_ 提示：“客户端应先注册监听器再 subscribe”。
3. #4 是协议设计（body 单独取），不是 bug，但 Firefox 对 `getRequestPostData` 的支持稳定性需要确认。
4. #5 是规范允许的事件异步性；强一致网络断言在 BiDi 下先天不可达，建议在产品层面提供“snapshot 时强制 flush/等待 responseCompleted”的辅助命令。

## 局限
- 行为受 Firefox/geckodriver 版本与时序影响，#3/#5 可能为非确定性复现，多次运行更易命中。
- 脚本拉的是 RoxyBrowser 托管的 Firefox，等价于标准 Firefox + geckodriver，不影响协议层结论。
