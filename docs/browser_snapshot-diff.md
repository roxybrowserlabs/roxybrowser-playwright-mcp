# `browser_snapshot` 差异对比

本文对比两个实现：

- 当前项目 MCP 工具中的 `browser_snapshot`
- Playwright 源码中的 `browser_snapshot`
  - `/Users/macos/code/roxy-company/playwright/packages/playwright-core/src/tools/backend/snapshot.ts`

## 结论摘要

两边工具名和主要参数看起来接近，但并不是同一层级的实现。

- Playwright 的 `snapshot.ts` 主要负责注册工具，并把 snapshot 采集委托给内部 response/tab 管线。
- 当前项目的 `browser_snapshot` 则直接在 MCP runtime 中完成参数解析、snapshot 生成、缓存、ref 解析和错误转换。
- Playwright 使用框架内建的 `page.ariaSnapshot({ mode: 'ai' })`。
- 当前项目使用自定义的页内 DOM/ARIA walker，通过 CDP/BiDi 注入脚本生成 snapshot。

因此，当前项目整体上是在“模拟 Playwright 风格输出”，而不是复用 Playwright 原生的 `browser_snapshot` 实现。

## 1. 实现分层不同

### Playwright

`snapshot.ts` 本身并不直接构造 snapshot 树。

- 在 `snapshot.ts` 中，`browser_snapshot` 的 handler 只做两件事：
  - 如有 `target`，先通过 `tab.targetLocator(...)` 解析目标
  - 调用 `response.setIncludeFullSnapshot(...)`
- 真正采集 snapshot 的逻辑在 `tab.ts` 中：
  - `root ? await root.ariaSnapshot({ mode: 'ai', depth, boxes })`
  - `: await this.page.ariaSnapshot({ mode: 'ai', depth, boxes })`
- 最终输出如何落盘、是否内联返回、如何组织 response section，则由 `response.ts` 处理。

换句话说，Playwright 的 `snapshot.ts` 更像“工具入口”，不是“snapshot 引擎本体”。

### 当前项目

当前项目的 MCP 方案把更多逻辑放在了服务和 runtime 里。

- `src/mcp/server.ts`
  - 注册 `browser_snapshot`
  - 直接调用 `runtime.snapshot(args)`
  - 再把结果格式化后返回，或写入文件
- `src/mcp/runtime.ts`
  - 负责 snapshot 参数转译
  - 负责 snapshot cache
  - 负责 `ref` / selector 目标解析
- `src/mcp/connectedBrowser.ts`
  - 负责在 CDP/BiDi 页面上下文里执行 snapshot 脚本
- `src/ariaSnapshot.ts`
  - 真正构造可读 snapshot 文本树
  - 真正维护 `ref -> nodeToken -> element` 映射

## 2. snapshot 生成方式不同

### Playwright

Playwright 依赖原生内建能力：

- `page.ariaSnapshot({ mode: 'ai', depth, boxes })`
- `locator.ariaSnapshot({ mode: 'ai', depth, boxes })`

这意味着：

- snapshot 行为由 Playwright 内核定义
- `aria-ref=...` 的解析也由 Playwright 自己处理
- DOM、iframe、可访问性树、locator 语义的一致性更强

### 当前项目

当前项目使用自定义脚本 `ARIA_SNAPSHOT_EVALUATE_SOURCE` 注入页面执行。

核心特点：

- 手动遍历 DOM
- 手动推断 role
- 手动计算 accessible name
- 手动判断可见性
- 手动把树渲染为 Playwright 风格文本
- 手动为可交互节点生成 `ref`

这意味着：

- 我们可以跨 CDP/BiDi 统一行为
- 但行为只是在“尽量接近” Playwright，不保证完全一致

## 3. `target` 解析能力不同

### Playwright

Playwright 对 `target` 的解析分两种路径：

- 如果不是 `ref`，会走 `locatorOrSelectorAsSelector('javascript', ...)`
- 如果是 `ref`，会走 `page.locator('aria-ref=...')`

因此它支持的是 Playwright 自己的 selector / locator 解析语义。

### 当前项目

当前项目也分两种路径：

- 如果是最近 snapshot 中的 `ref`，先从 cache 中解析为 `nodeToken`
- 否则按普通 selector 处理

但这里的“普通 selector”在 snapshot 子树定位场景下，本质是：

- `document.querySelectorAll(...)`

因此当前项目的 selector 兼容范围更接近标准 CSS selector，而不是完整的 Playwright selector 语义。

直接影响：

- Playwright 里一些可工作的 selector 写法，在当前项目里不一定可用
- 当前项目对 selector 严格依赖浏览器原生 `querySelectorAll`

## 4. `ref` 机制不同

### Playwright

Playwright 对 ref 的处理是原生的。

- snapshot 中会生成类似 `e2`、`f1e4` 这样的引用
- 后续通过 `page.locator('aria-ref=...')` 解析
- ref 的有效性由 Playwright 自己的 snapshot/locator 体系保障

### 当前项目

当前项目的 ref 机制完全是自定义的。

- 在页内全局状态 `globalThis.__roxyMcpState` 中保存：
  - `refs`
  - `elements`
  - `nextRefId`
  - `nextNodeId`
- 生成 ref 时：
  - 给元素挂 `__roxyAriaRef`
  - 生成 `nodeToken`
  - 保存 `ref -> nodeToken`
  - 保存 `nodeToken -> element`
- MCP runtime 再把本次 snapshot 的 `refs` 拷贝到 `snapshotCache`

当前设计的特点：

- ref 有两层映射：MCP runtime cache 一层，页内全局状态一层
- 可以显式把“旧 ref 不可用”转成 `stale_ref`
- 更容易跨协议统一

但也有差异：

- 它不是 Playwright 原生的 `aria-ref` 实现
- ref 稳定性和失效语义由我们自己定义

## 5. snapshot 缓存策略不同

### Playwright

从当前看到的 backend 链路看，`browser_snapshot` 本身没有我们这种显式的 `tabId + requestKey` 缓存层。

### 当前项目

当前项目在 `runtime.snapshot(...)` 中显式缓存：

- 按 `tabId`
- 按 `requestKey`
  - `target`
  - `depth`
  - `boxes`

如果命中缓存，会直接复用：

- `text`
- `refs`
- `title`
- `url`

这带来的实际差异：

- 当前项目会主动避免相同请求重复生成 snapshot
- Playwright 的 `browser_snapshot` 工具层没有暴露出这类缓存逻辑

## 6. 错误模型不同

### Playwright

Playwright 在 ref 解析失败时，通常抛出类似：

- `Ref ${param.target} not found in the current page snapshot. Try capturing new snapshot.`

selector 失败时则是另一套错误路径。

### 当前项目

当前项目把错误明确收敛成 MCP 错误码：

- `stale_ref`
- `invalid_target`
- `invalid_tab_index`
- `not_connected`
- `no_active_tab`

尤其是 snapshot 相关目标错误，被进一步细分为：

- 旧 ref 已失效
- selector 无效
- selector 没匹配到元素
- selector 命中多个元素

这让 MCP 调用方更容易做程序化处理，但和 Playwright 原生错误文本并不完全一致。

## 7. 输出格式不同

### Playwright

Playwright 的 response 管线会把 snapshot 当成一个 section 来处理：

- 未显式要求写文件时，可能直接以 `Snapshot` section 内联返回
- 需要写文件时，会先写入文件，再在 response 中返回文件链接

写入文件的内容是原始 `ariaSnapshot` 文本。

### 当前项目

当前项目会先格式化为：

```text
Snapshot (<title> - <url>):
<snapshot text>
```

然后：

- 不传 `filename` 时直接返回这段文本
- 传 `filename` 时直接把这段格式化后的文本写入目标文件

因此差异是：

- Playwright 写文件时保存的是原始 snapshot
- 当前项目写文件时保存的是带标题头包装的格式化文本

## 8. 可见性和节点纳入规则不同

当前项目在 `src/ariaSnapshot.ts` 中自己定义了很多纳入规则，这些规则未必与 Playwright 内建实现完全一致。

例如：

- `display: none` / `visibility: hidden` / 宽高为 0 时默认认为不可见
- `iframe` 会被特殊纳入
- `slot` 和 `shadowRoot` 会手动展开
- `generic` 无名节点会做扁平化
- `textbox` 会把 `value` 作为子文本
- `checkbox` / `radio` / `option` 会附加状态
- 只有在 `mode === 'ai'` 且可见且可接收 pointer events 时才暴露 `ref`

这些规则说明：

- 当前项目的输出是“Playwright 风格”
- 但不是“保证与 Playwright 内核逐字节一致”

## 9. iframe / shadow DOM 行为不同

### Playwright

Playwright 通过原生 `ariaSnapshot({ mode: 'ai' })` 支持 iframe snapshot。

### 当前项目

当前项目对 iframe/shadow DOM 做了手动处理：

- `iframe` 在 `mode === 'ai'` 时尝试读取 `contentDocument`
- `shadowRoot` 子节点会被递归访问
- `slot.assignedNodes()` 会被展开

这保证了当前项目有较强的兼容能力，但仍可能和 Playwright 的内建边界行为不完全一致，特别是在：

- 跨域 iframe
- 特殊可访问性角色映射
- 复杂 slot/shadow tree 场景

## 10. 协议适配方式不同

### Playwright

Playwright 直接运行在自己的 page/locator/runtime 体系上。

### 当前项目

当前项目需要同时兼容：

- CDP
- BiDi

因此 snapshot 逻辑被设计为：

- 一份页内 evaluate 脚本
- 两套协议执行壳
  - `evaluateCdp(...)`
  - `evaluateBiDi(...)`

这也是为什么当前项目更倾向于自定义 snapshot 脚本，而不是依赖 Playwright 内建 `page.ariaSnapshot(...)`。

## 11. 与点击/悬停链路的耦合方式不同

### Playwright

Playwright 的点击、悬停等工具直接基于 locator 体系工作，`browser_snapshot` 只是提供一个 AI 可消费的页面表示。

### 当前项目

当前项目里 snapshot 与交互链路耦合得更紧：

- `browser_click` 可直接接受 snapshot ref 或 selector
- `browser_hover` 依赖最近一次 snapshot 的 ref
- `click` / `hover` 后会主动失效当前 snapshot cache
- 之后再次使用旧 ref 会得到 `stale_ref`

这使当前 MCP 工具形成了一个明显的状态机：

1. `browser_snapshot`
2. 用 ref 交互
3. 旧 snapshot 失效
4. 需要重新 `browser_snapshot`

这个行为模式与 Playwright 工具体验相似，但当前项目把它实现得更显式。

## 12. 参数层面的相同点

虽然内部差异较大，但两边在接口表面仍然高度相似：

- 都支持 `target`
- 都支持 `filename`
- 都支持 `depth`
- 都支持 `boxes`
- 都面向 AI snapshot 场景

所以从调用者视角看，当前项目是在尽量保持 Playwright 风格兼容。

## 13. 当前项目相对 Playwright 原生实现的主要差异清单

可以把差异压缩成下面这几条：

1. Playwright 的 `snapshot.ts` 是工具入口；当前项目同时实现了工具入口、runtime、snapshot 引擎和 ref 生命周期。
2. Playwright 用内建 `ariaSnapshot({ mode: 'ai' })`；当前项目用自定义注入脚本生成文本树。
3. Playwright 的 ref 解析依赖 `aria-ref` locator；当前项目依赖自建 `ref -> nodeToken -> element` 映射。
4. Playwright 的 selector 解析语义更接近 Playwright locator；当前项目更多依赖原生 CSS selector。
5. 当前项目有显式 snapshot cache；Playwright 这层 backend 工具代码里没有对应缓存逻辑。
6. 当前项目把 snapshot 错误归一成 MCP 错误码；Playwright 更偏向原生工具/locator 错误文本。
7. 当前项目写文件时会写入格式化包装文本；Playwright 写入的是原始 aria snapshot。
8. 当前项目的可见性、role、name、flatten、iframe、shadow DOM 处理都是自定义规则，因此只能近似兼容 Playwright，不保证完全一致。

## 14. 对后续兼容工作的启发

如果后面要进一步向 Playwright 原生 `browser_snapshot` 对齐，优先级最高的点通常是：

1. 对齐 selector 语义，减少“Playwright 可用、当前项目不可用”的情况。
2. 对齐 ref 生命周期和失效边界，避免旧 ref 行为偏差。
3. 对齐 snapshot 文本渲染规则，特别是 role、name、文本折叠、generic flatten 和 iframe/shadow DOM 表现。
4. 明确 `filename` 输出到底要兼容 Playwright 的“原始 snapshot 文件”，还是保留当前项目的“格式化标题头”。

## 参考文件

- 当前项目
  - `/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/src/mcp/server.ts`
  - `/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/src/mcp/runtime.ts`
  - `/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/src/mcp/connectedBrowser.ts`
  - `/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/src/ariaSnapshot.ts`
  - `/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/src/mcp/format.ts`
- Playwright
  - `/Users/macos/code/roxy-company/playwright/packages/playwright-core/src/tools/backend/snapshot.ts`
  - `/Users/macos/code/roxy-company/playwright/packages/playwright-core/src/tools/backend/tab.ts`
  - `/Users/macos/code/roxy-company/playwright/packages/playwright-core/src/tools/backend/response.ts`
