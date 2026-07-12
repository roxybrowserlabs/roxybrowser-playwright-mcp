# Firefox BiDi 示例

这个示例展示了如何使用 WebDriver BiDi 协议连接到已运行的 Firefox 浏览器。

## 运行示例

```bash
node examples/page/launch-firefox-bidi.mjs
```

## 示例功能

该示例演示了以下功能：

1. **连接 Firefox**：使用 BiDi WebSocket 端点连接 Firefox 浏览器
2. **页面导航**：导航到本地 HTML 文件
3. **表单交互**：填充输入框并点击按钮
4. **元素查询**：读取页面元素的文本内容
5. **JavaScript 执行**：在页面上下文中执行 JavaScript
6. **截图**：捕获页面截图
7. **HTML 获取**：获取完整的页面 HTML
8. **导航控制**：前进/后退导航

## 关键代码

```javascript
import { firefox } from "@roxybrowser/playwright";

const endpointURL = process.env.ROXY_BIDI_ENDPOINT;
if (!endpointURL) {
  throw new Error("Set ROXY_BIDI_ENDPOINT to a ws://... BiDi endpoint.");
}

// 连接 Firefox
const browser = await firefox.connect(endpointURL);

// 创建上下文和页面
const context = await browser.newContext();
const page = await context.newPage();

// 导航到页面
await page.goto("https://example.com");

// 与页面交互
await page.fill("#name", "Hello BiDi");
await page.getByRole("button", { name: "Send" }).click();

// 执行 JavaScript
const userAgent = await page.evaluate(() => navigator.userAgent);

// 截图
const screenshot = await page.screenshot();

// 清理
await browser.close();
```

## 技术细节

### BiDi 协议

WebDriver BiDi 是 WebDriver 的下一代协议，提供：
- 双向通信（浏览器可以主动推送事件）
- 更好的性能
- 更丰富的 API

### 实现要点

1. **连接 Firefox**：RoxyBrowser 通过已暴露的 BiDi WebSocket 端点连接 Firefox
2. **WebSocket 通信**：BiDi 使用 WebSocket 进行双向通信
3. **事件订阅**：可以订阅浏览器事件（导航、网络请求等）

## 故障排除

### 问题：Firefox 连接失败

确保 Firefox 已经以 BiDi/远程调试模式运行，并且 `ROXY_BIDI_ENDPOINT` 指向正确的 WebSocket 端点。

例如：

```bash
export ROXY_BIDI_ENDPOINT=ws://127.0.0.1:9222/session
```

### 问题：BiDi 端口未暴露

确认 Firefox 已以远程调试模式运行，并检查 stderr 中是否出现 `WebDriver BiDi listening`。

## 相关资源

- [WebDriver BiDi 规范](https://w3c.github.io/webdriver-bidi/)
- [Firefox WebDriver 文档](https://firefox-source-docs.mozilla.org/testing/geckodriver/)
- [webdriver 包文档](https://www.npmjs.com/package/webdriver)
