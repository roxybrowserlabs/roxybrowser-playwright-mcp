# Examples

示例按调用入口分三类存放：

- `mcp/`: MCP 工具实例，包含 RoxyBrowser MCP 与 Playwright MCP 的端到端验证脚本；需要先 `pnpm build` 生成 `dist/`。
- `page/`: Page 实例，也就是直接调用 `@roxybrowser/playwright` 的 Browser / Context / Page API。
- `repro/`: bug 复现脚本，优先放最小复现和诊断说明；协议或内核相关复现可以继续按协议建子目录，例如 `repro/bidi/`。

共享文件就近放置。只服务某一类示例的 helper 或资产放在对应目录下，例如 `page/helpers/`、`mcp/assets/`；只有被多类示例共同使用时才提升到 `examples/shared/`。

## Runner

推荐通过统一 runner 执行示例：

```bash
pnpm examples mcp launch-stdio
pnpm examples page verify-baidu-search
pnpm examples page connect-over-cdp
pnpm examples repro bidi 01-click-alert-blocks
```

runner 会加载仓库根目录的 `.env`，定位 `examples/<module>/<script>.mjs`，并向子进程统一注入环境变量：

- `ROXY_CDP_ENDPOINT`: Chromium/CDP 连接端点，兼容同步注入旧名 `ROXY_CDP_WS_ENDPOINT`。
- `ROXY_BIDI_ENDPOINT`: Firefox/WebDriver BiDi 连接端点，兼容同步注入旧名 `ROXY_BIDI_WS_ENDPOINT`。

如果目标示例需要 endpoint，但当前环境没有设置对应变量，runner 会在存在 `ROXYBROWSER_API_TOKEN` 或 `ROXY_API_TOKEN` 时尝试通过 RoxyBrowser 本地 API 打开对应类型的浏览器 profile 并注入 endpoint。脚本自身仍可直接用 `node examples/...` 执行，此时需要手动提供对应 endpoint。
