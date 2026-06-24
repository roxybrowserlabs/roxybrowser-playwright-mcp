/**
 * 测试脚本：通过 MCP Server 连接远端浏览器并打开百度
 *
 * 用法：
 *   # Chrome CDP
 *   ENDPOINT=ws://127.0.0.1:PORT/devtools/browser/xxx \
 *   BROWSER=Chrome \
 *   node test/test_mcp_connect.mjs
 *
 *   # Firefox BiDi
 *   ENDPOINT=ws://127.0.0.1:PORT/session \
 *   BROWSER=Firefox \
 *   node test/test_mcp_connect.mjs
 */

// dist 是 webpack 打包的产物，patch 需要在构建前应用。
// 这里直接从源码入口导入（tsx 会即时编译 TypeScript）
import { connectMemory } from '../src/index.ts';

const ENDPOINT = process.env.ENDPOINT;
const BROWSER = process.env.BROWSER || 'Chrome';

if (!ENDPOINT) {
  console.error('❌ 请设置 ENDPOINT 环境变量');
  process.exit(1);
}

console.log(`🔌 通过 MCP Server 连接 ${BROWSER} ...`);
console.log(`   端点: ${ENDPOINT}`);

// 启动 in-memory MCP server
const { server, clientTransport, close } = await connectMemory();

// 辅助函数：发送 MCP 请求
async function callTool(name, args = {}) {
  const request = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args },
  };
  clientTransport.send(request);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Tool ${name} timeout`)), 60000);
    clientTransport.onmessage = (msg) => {
      if (msg.id === request.id) {
        clearTimeout(timeout);
        resolve(msg.result || msg.error);
      }
    };
  });
}

try {
  // Step 1: 列出可用工具
  console.log('\n📋 Step 1: 列出可用工具');
  const listRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  };
  clientTransport.send(listRequest);
  const toolsResult = await new Promise((resolve) => {
    clientTransport.onmessage = (msg) => {
      if (msg.id === 1) resolve(msg.result);
    };
  });
  console.log(`   找到 ${toolsResult.tools.length} 个工具`);
  console.log(`   其中 browser_connect_roxy: ${toolsResult.tools.some(t => t.name === 'browser_connect_roxy') ? '✅' : '❌'}`);

  // Step 2: 通过 browser_connect_roxy 连接浏览器
  console.log(`\n📋 Step 2: 调用 browser_connect_roxy`);
  const connectResult = await callTool('browser_connect_roxy', {
    endpoint: ENDPOINT,
    browserCore: BROWSER,
  });
  console.log('   结果:', JSON.stringify(connectResult, null, 2).slice(0, 300));

  // Step 3: 打开百度
  console.log(`\n📋 Step 3: 打开百度`);
  const navResult = await callTool('browser_navigate', {
    url: 'https://www.baidu.com',
  });
  console.log('   结果:', JSON.stringify(navResult, null, 2).slice(0, 500));

  // Step 4: 截图
  console.log(`\n📋 Step 4: 截图`);
  const screenshotResult = await callTool('browser_take_screenshot', {});
  console.log('   结果:', JSON.stringify(screenshotResult, null, 2).slice(0, 300));

  // Step 5: 获取页面快照（a11y tree）
  console.log(`\n📋 Step 5: 获取页面快照`);
  const snapshotResult = await callTool('browser_snapshot', {});
  console.log('   结果:', JSON.stringify(snapshotResult, null, 2).slice(0, 800));

  console.log('\n✅ MCP 连接测试完成');
} catch (err) {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
} finally {
  await close();
  console.log('👋 已关闭 MCP Server');
}
