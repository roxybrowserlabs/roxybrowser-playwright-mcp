# BiDi (WebDriver BiDi) Examples

这些示例展示了如何使用 BiDi 协议连接和控制 Firefox 浏览器。

## 什么是 BiDi？

WebDriver BiDi 是新一代的浏览器自动化协议，旨在取代传统的 WebDriver 和 CDP (Chrome DevTools Protocol)。它提供：

- **双向通信**：支持浏览器主动推送事件
- **跨浏览器标准**：Firefox、Chrome、Safari 等主流浏览器都在实现
- **更好的性能**：基于 WebSocket 的持久连接
- **现代化 API**：支持最新的浏览器特性

## 示例文件

### 1. `launch-firefox-bidi.mjs` - 启动 Firefox

这个示例展示如何直接启动 Firefox 浏览器并使用 BiDi 协议进行自动化。

**运行方式：**

```bash
pnpm example:launch-bidi
```

**可选环境变量：**

```bash
# 指定 Firefox 可执行文件路径
export ROXY_EXECUTABLE_PATH=/path/to/firefox

# 运行示例
pnpm example:launch-bidi
```

**示例功能：**
- 启动 Firefox 浏览器
- 创建浏览器上下文和页面
- 设置事件监听器（console、request、response）
- 页面导航和交互
- JavaScript 执行
- 截图
- 前进/后退导航

### 2. `connect-firefox-bidi.mjs` - 连接到已运行的 Firefox

这个示例展示如何连接到已经运行的 Firefox 实例。

**运行方式：**

1. 首先，手动启动 Firefox 并开启远程调试：

```bash
# macOS
/Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port=9222

# Linux
firefox --remote-debugging-port=9222

# Windows
"C:\Program Files\Mozilla Firefox\firefox.exe" --remote-debugging-port=9222
```

2. 运行示例：

```bash
pnpm example:connect-bidi
```

**可选环境变量：**

```bash
# 指定 WebSocket 端点（默认：ws://127.0.0.1:9222）
export ROXY_BIDI_WS_ENDPOINT=ws://127.0.0.1:9222

# 运行示例
pnpm example:connect-bidi
```

**示例功能：**
- 连接到已运行的 Firefox
- 表单填充和按钮点击
- 读取页面内容
- 截图

## 代码示例

### 启动 Firefox

```javascript
import { firefox } from "@roxybrowser/playwright";

const browser = await firefox.launch({
  headless: false
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 720 }
});

const page = await context.newPage();
await page.goto("https://example.com");
```

### 连接到已运行的 Firefox

```javascript
import { firefox } from "@roxybrowser/playwright";

const browser = await firefox.connect({
  wsEndpoint: "ws://127.0.0.1:9222",
  browserName: "firefox"
});

const context = await browser.newContext();
const page = await context.newPage();
```

### 页面交互

```javascript
// CSS 选择器
await page.fill("#username", "user");

// Role 选择器
await page.getByRole("button", { name: "Submit" }).click();

// Text 选择器
await page.getByText("Welcome").click();

// Locator
const status = await page.locator("#status").textContent();
```

### 事件监听

```javascript
page.on("console", (msg) => {
  console.log(`Console: ${msg.text()}`);
});

page.on("request", (request) => {
  console.log(`Request: ${request.url}`);
});

page.on("response", (response) => {
  console.log(`Response: ${response.status} ${response.url}`);
});
```

## 常见问题

### Q: BiDi 和 CDP 有什么区别？

A: 
- **CDP** 是 Chrome 特有的协议，主要用于 Chromium 系浏览器
- **BiDi** 是跨浏览器的标准协议，Firefox、Chrome 等都在实现
- BiDi 提供更标准化的 API 和更好的跨浏览器兼容性

### Q: 为什么选择 BiDi？

A:
- Firefox 官方推荐使用 BiDi 协议
- 更好的标准化和未来兼容性
- 支持双向通信，可以接收浏览器事件
- 性能更好

### Q: 如何调试 BiDi 连接问题？

A:
1. 确保 Firefox 已正确启动并开启远程调试端口
2. 检查端口是否被占用：`lsof -i :9222`
3. 验证 WebSocket 端点是否可访问：`curl http://127.0.0.1:9222/json/version`
4. 查看 Firefox 的 stderr 输出，确认 "DevTools listening" 消息

### Q: 支持哪些 Firefox 版本？

A: 建议使用 Firefox 115 或更高版本，这些版本对 BiDi 协议有更完整的支持。

## 更多资源

- [WebDriver BiDi 规范](https://w3c.github.io/webdriver-bidi/)
- [Firefox BiDi 实现状态](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)
- [Roxy Browser 文档](../README.md)

## 故障排除

### Firefox 无法启动

```bash
# 检查 Firefox 是否已安装
which firefox  # Linux/macOS
where firefox  # Windows

# 手动指定路径
export ROXY_EXECUTABLE_PATH=/path/to/firefox
```

### 连接超时

```bash
# 增加超时时间（在代码中）
const browser = await firefox.connect({
  wsEndpoint: "ws://127.0.0.1:9222",
  browserName: "firefox",
  timeout: 30000  // 30 秒
});
```

### 端口已被占用

```bash
# 使用不同的端口
firefox --remote-debugging-port=9223

# 更新环境变量
export ROXY_BIDI_WS_ENDPOINT=ws://127.0.0.1:9223
```
