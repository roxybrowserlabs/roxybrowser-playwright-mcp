# `@roxybrowser/playwright-mcp`

RoxyBrowser 定制版 Playwright MCP Server。

[English](./README.md)

## 安装

```bash
pnpm install @roxybrowser/playwright-mcp
```

## 导出方法

```ts
import {
  createConnection,
  connectStdio,
  connectMemory,
  startServer,
} from '@roxybrowser/playwright-mcp';
```

### `connectStdio()`

启动并连接 `stdio` transport。

### `startServer()`

启动 HTTP 服务并返回 MCP 地址。

### `connectMemory()`

启动内存 transport，适合进程内集成。

### `createConnection()`

仅创建 `Server`，由调用方自己管理 transport。

## 示例

```ts
import { startServer } from '@roxybrowser/playwright-mcp';

const server = await startServer({
  port: 9324,
  host: '127.0.0.1',
});

console.log(server.url);
```

## MCP 客户端配置示例

部分客户端可以直接使用这个 MCP 服务：

```json
{
  "mcpServers": {
    "roxybrowser-playwright-mcp": {
      "command": "npx",
      "args": [
        "@roxybrowser/playwright-mcp@latest"
      ]
    }
  }
}
```
