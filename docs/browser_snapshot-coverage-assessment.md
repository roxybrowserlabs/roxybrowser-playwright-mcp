# `browser_snapshot` 能力覆盖与 API 一致性评估

本文记录本次调查结论，重点回答两个问题：

1. 当前项目的 `browser_snapshot` 与 Playwright 相比，谁的能力覆盖更多？
2. 如果目标是“对外 API 设计一模一样”，当前项目距离这个目标还有多远？

## 结论

结论很明确：

- 从能力覆盖看，Playwright 明显更多。
- 从对外 API 一致性看，当前项目还没有达到“与 Playwright 一模一样”。
- 当前项目更接近“实现了 Playwright MCP / aria snapshot 的一个子集，并补充了少量自定义能力”。
- 如果后续目标是 API 完全兼容，最合理的做法是直接把 Playwright 的相关测试当作 contract。

## 为什么说 Playwright 覆盖更多

Playwright 的测试覆盖不是只测一个 `browser_snapshot` 工具，而是分成了至少两层：

- 页面 / locator / aria snapshot 能力本身
- MCP 工具层的协议表现

这两层合起来，覆盖面明显大于当前项目。

## 1. Playwright 的页面级 snapshot 覆盖更广

与 snapshot 最相关的两个核心测试文件是：

- [`page-aria-snapshot.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/page/page-aria-snapshot.spec.ts:26)
- [`page-aria-snapshot-ai.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/page/page-aria-snapshot-ai.spec.ts:26)

这两份文件本身就已经非常大：

- `page-aria-snapshot.spec.ts`: 776 行
- `page-aria-snapshot-ai.spec.ts`: 815 行

它们覆盖的能力包括但不限于：

- 基础 role / name / text snapshot
- list / link / heading / group / paragraph 等结构化输出
- 文本节点处理
- multiline text
- whitespace normalization
- pseudo element 内容
- hidden pseudo 排除
- slot / shadow DOM
- `aria-hidden`
- `aria-owns`
- placeholder / textarea / input value
- depth 限制
- box 输出
- iframe snapshot
- iframe 内 locator snapshot
- iframe ref 拼接
- active element 标记
- `pointer-events: none` 对 ref 暴露的影响
- generic 节点折叠
- 跨帧 ref 稳定性
- auto-wait
- 增量 snapshot

这说明 Playwright 的 snapshot 能力不是只看“能不能吐一段文本”，而是覆盖了大量边界和真实使用场景。

## 2. Playwright 的 MCP 工具层也有专门覆盖

与 `browser_snapshot` 直接相关的 MCP 测试至少包括：

- [`core.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/core.spec.ts:21)
- [`snapshot-mode.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/snapshot-mode.spec.ts:21)
- [`click.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/click.spec.ts:19)
- [`devtools.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/devtools.spec.ts:21)
- [`tabs.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/tabs.spec.ts:36)
- [`cdp.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/cdp.spec.ts:24)

这些测试不只是验证 snapshot 文本，还覆盖了：

- snapshot 在导航后的表现
- snapshot depth / boxes 选项
- snapshot by ref
- 旧 ref 失效时的行为
- `--snapshot-mode=full`
- `--snapshot-mode=none`
- `snapshot[filename]`
- click 与 snapshot 的联动
- devtools 中 `aria-ref` 高亮链路
- tab 切换/复用与 snapshot 的关系
- CDP attach 场景

也就是说，Playwright 实际在测的是“完整产品行为”，而不是单独一段生成文本的函数。

## 3. 当前项目的测试很多，但重心不一样

当前项目与 snapshot 最相关的测试主要是：

- [`tests/unit/ariaSnapshot.test.ts`](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/unit/ariaSnapshot.test.ts:102)
- [`tests/unit/mcp.test.ts`](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/unit/mcp.test.ts:145)
- [`tests/unit/page.test.ts`](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/unit/page.test.ts:11)

这些文件行数也不小：

- `ariaSnapshot.test.ts`: 857 行
- `mcp.test.ts`: 534 行
- `page.test.ts`: 388 行

当前项目确实覆盖了不少内容，例如：

- selector-targeted snapshot
- ref-targeted snapshot
- depth / boxes
- strict / not_found / stale 错误
- visibility 边界
- selector / xpath / querySelectorChain 元数据
- iframe framePath 元数据
- nested iframe querySelectorChain
- shadow DOM / slot 行为
- MCP runtime cache
- stale_ref 错误
- click / hover 与 snapshot cache 失效

但这里有一个关键区别：

- 我们大量覆盖的是“自定义实现细节”和“内部辅助能力”
- Playwright 更多覆盖的是“公开 API 契约”和“真实产品链路”

所以如果单纯问“谁覆盖更多对外能力”，答案仍然是 Playwright。

## 4. 当前项目 e2e 对 snapshot 的覆盖明显不如 Playwright

当前项目实际 e2e 文件只有：

- [`tests/e2e/browser-flow.test.ts`](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/browser-flow.test.ts:1)

这份测试验证了真实浏览器驱动流程，但它主要关注：

- launch
- newContext / newPage
- goto
- fill / click / type / press
- DOM 结果变化

它并不是一个专门围绕 `browser_snapshot` 的 e2e 契约测试。

相比之下，Playwright 在页面层和 MCP 层都对 snapshot 相关行为做了大量真实场景覆盖。

因此：

- 从单元测试数量看，当前项目不算少
- 但从“snapshot 公开能力的端到端验证”看，Playwright 更完整

## API 一致性评估

如果目标是“暴露的 API 设计一模一样，并不太关注如何实现”，那么当前项目还没有完全对齐。

下面是最关键的差异。

## 5. iframe ref 公开格式尚未对齐

Playwright 的 AI snapshot 会公开输出跨 iframe 的 ref，例如：

- `f1e1`
- `f1e2`
- `f4e2`

对应测试见：

- [`page-aria-snapshot-ai.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/page/page-aria-snapshot-ai.spec.ts:76)
- [`page-aria-snapshot-ai.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/page/page-aria-snapshot-ai.spec.ts:102)
- [`page-aria-snapshot-ai.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/page/page-aria-snapshot-ai.spec.ts:145)

而当前项目本次检索结果里，没有看到任何对 `f...e...` 这种公开 ref 形式的测试断言。

这意味着：

- 至少从当前测试 contract 来看，我们还没有证明自己对齐了 Playwright 的 iframe ref API 表现

如果“API 一模一样”是目标，这是一处非常明确的缺口。

## 6. `filename` 行为尚未完全对齐

Playwright 的 MCP 测试中，`browser_snapshot` 配合 `filename` 的行为见：

- [`snapshot-mode.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/snapshot-mode.spec.ts:99)

它验证的是：

- 调用成功
- 文件落盘
- 文件内容包含原始 snapshot 文本

当前项目则是：

- 先格式化成 `Snapshot (<title> - <url>):\n...`
- 再把格式化后的文本写入文件

也就是说当前项目的落盘格式带了额外包装。

如果目标是 API 兼容，那么这里应该优先以 Playwright 行为为准。

## 7. selector / locator 语义尚未完全对齐

Playwright 工具层对 `target` 的解析，不只是标准 CSS selector，而是其 locator / selector 体系的一部分。

当前项目更多依赖：

- snapshot cache 中的 ref
- 否则走原生 selector 解析

这会导致一个现实问题：

- 某些在 Playwright 工具中可工作的 target 表达方式，在当前项目中不一定等价可用

如果关注点是“暴露 API 相同”，那 selector 行为应以 Playwright 的对外语义为基准，而不是以当前内部实现便利性为基准。

## 8. 错误表现尚未完全对齐

Playwright 测试里会校验旧 ref 的错误文本，例如：

- [`core.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/core.spec.ts:177)

当前项目虽然也有：

- `stale_ref`
- `invalid_target`

这样的结构化错误设计，但这不等于对外表现已经和 Playwright 完全一致。

如果兼容目标是 API 层面的“同形”，那么需要对齐的不只是错误类别，还包括：

- 何时报错
- 错误文本
- 哪些场景是 stale
- 哪些场景是 invalid target

## 9. snapshot mode / devtools / 辅助工具链路尚未完整对齐

Playwright 对 snapshot 的 API 契约，不只体现在 `browser_snapshot` 返回值。

它还体现在：

- `--snapshot-mode=full` / `none`
- `snapshot[filename]`
- devtools 高亮 `aria-ref`
- click / hover / tabs / cdp attach 等联动

对应测试见：

- [`snapshot-mode.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/snapshot-mode.spec.ts:21)
- [`devtools.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/devtools.spec.ts:21)
- [`click.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/click.spec.ts:19)
- [`tabs.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/tabs.spec.ts:36)
- [`cdp.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/cdp.spec.ts:24)

当前项目目前没有等价规模的 snapshot e2e 契约覆盖。

因此不能认为 API 行为已经完全一致。

## 总结判断

### 问题 1：谁的能力覆盖更多？

答案：Playwright。

原因：

- 页面级 snapshot 能力覆盖更广
- MCP 工具层覆盖更完整
- 真实链路测试更多
- 对 iframe、active element、incremental snapshot、devtools 等高级行为有成熟 contract

### 问题 2：当前项目是否已经实现了“一模一样的 API 设计”？

答案：还没有。

最明显的未对齐点包括：

- iframe ref 公开格式
- `filename` 落盘内容
- selector / locator 语义
- 错误文本与错误边界
- snapshot mode 行为
- devtools / highlight / tabs / CDP 联动表现

## 建议

如果接下来目标是“对外 API 一模一样”，建议不要继续以当前实现细节为主线，而应改为：

1. 以 Playwright 的测试为外部契约。
2. 先对齐 `page.ariaSnapshot({ mode: 'ai' })` 的公开表现。
3. 再对齐 `tests/mcp/*.spec.ts` 中 `browser_snapshot` 相关工具行为。
4. 当前项目已有的自定义 helper 能力，仅保留为内部实现手段，不要反向定义公开 API。

## 推荐的兼容基线

如果需要一个明确基线，建议优先参考这些文件：

- 页面级
  - [`page-aria-snapshot.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/page/page-aria-snapshot.spec.ts:26)
  - [`page-aria-snapshot-ai.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/page/page-aria-snapshot-ai.spec.ts:26)
- MCP 级
  - [`core.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/core.spec.ts:21)
  - [`snapshot-mode.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/snapshot-mode.spec.ts:21)
  - [`click.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/click.spec.ts:19)
  - [`devtools.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/devtools.spec.ts:21)
  - [`tabs.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/tabs.spec.ts:36)
  - [`cdp.spec.ts`](/Users/macos/code/roxy-company/playwright/tests/mcp/cdp.spec.ts:24)

## 调查范围说明

本次结论基于本地代码与测试文件静态对比得出，未实际跑完整测试矩阵。

调查过程中重点查看了：

- 当前项目
  - `tests/unit/ariaSnapshot.test.ts`
  - `tests/unit/mcp.test.ts`
  - `tests/unit/page.test.ts`
  - `tests/e2e/browser-flow.test.ts`
- Playwright
  - `tests/page/page-aria-snapshot.spec.ts`
  - `tests/page/page-aria-snapshot-ai.spec.ts`
  - `tests/mcp/core.spec.ts`
  - `tests/mcp/snapshot-mode.spec.ts`
  - `tests/mcp/click.spec.ts`
  - `tests/mcp/devtools.spec.ts`
  - `tests/mcp/tabs.spec.ts`
  - `tests/mcp/cdp.spec.ts`
