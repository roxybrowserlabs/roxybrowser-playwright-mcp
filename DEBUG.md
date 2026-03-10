# 本地调试 MCP Server

## 方式一：用 Cursor / VS Code 断点调试（推荐）

1. 在 `customBackend.js` 或 `cli.js` 里需要的地方打断点。
2. 按 **F5** 或菜单 **运行 → 启动调试**，在列表里选：
   - **Debug MCP Server (stdio)**：按 stdio 方式启动，适合用 Cursor 的 MCP 配置连到本进程调试。
   - **Debug MCP Server (HTTP :9324)**：以 HTTP 方式启动，在 9324 端口，方便用另一个终端或 MCP 客户端连 `http://localhost:9324/mcp` 调 list_tools / call_tool。
3. 若选 **stdio**：在 Cursor 的 MCP 配置里临时改成用「运行并调试」对应的命令（见下），即可在断点处停下。

### Cursor 里用 stdio 连到“正在调试”的进程

当前 Cursor 一般会自己起子进程跑 MCP（例如 `npx roxybrowser-mcp-server-playwright`），那样断点不会进你正在调试的进程。

**做法**：先不用 Cursor 自带的 MCP 启动，而是：

- 用 **Debug MCP Server (HTTP :9324)** 启动并断点调试；
- 在 Cursor 的 MCP 配置里填 **URL** 而不是 command，例如：
  ```json
  "mcpServers": {
    "playwright": {
      "url": "http://localhost:9324/mcp"
    }
  }
  ```
- 先启动调试（F5，选 HTTP 配置），等终端里出现 `Listening on http://...` 后，再在 Cursor 里使用 MCP，断点就会命中。

## 方式二：命令行 + Chrome DevTools

```bash
# 带 inspect，方便用 Chrome 或 edge://inspect 附加
pnpm run dev          # stdio + --inspect
pnpm run dev:http     # HTTP :9324 + --inspect
```

然后打开 Chrome，访问 `chrome://inspect`，在 Remote Target 里找到 Node 进程并点 **inspect**，即可在 Sources 里下断点、看调用栈。

## 方式三：只跑起来看日志

```bash
pnpm start                  # stdio
pnpm start -- --port 9324   # HTTP
```

不加 `--inspect` 时不能断点，但可以在代码里用 `console.error` 打日志观察。

## 小结

| 目的           | 做法 |
|----------------|------|
| 断点调 backend/CLI | F5 → 选 **Debug MCP Server (HTTP :9324)**，Cursor MCP 配置用 `"url": "http://localhost:9324/mcp"` |
| 用 Chrome 调 Node | `pnpm run dev:http`，然后 chrome://inspect 附加 |
| 快速跑一下     | `pnpm start` 或 `pnpm start -- --port 9324` |
