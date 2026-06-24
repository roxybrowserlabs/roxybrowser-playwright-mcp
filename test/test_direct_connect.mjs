/**
 * 测试脚本：直接 connect 远端浏览器并打开百度
 *
 * 用法：
 *   # Chrome CDP
 *   ENDPOINT=ws://127.0.0.1:PORT/devtools/browser/xxx \
 *   BROWSER=Chrome \
 *   node test/test_direct_connect.mjs
 *
 *   # Firefox BiDi
 *   ENDPOINT=ws://127.0.0.1:PORT/session \
 *   BROWSER=Firefox \
 *   node test/test_direct_connect.mjs
 *
 *   # 默认 Chrome，不设 BROWSER 也行
 *   ENDPOINT=ws://127.0.0.1:9222/devtools/browser/xxx \
 *   node test/test_direct_connect.mjs
 */

// 直接从 node_modules 导入 playwright，使用已 patched 的版本
// （dist 是 webpack 打包的，需要 rebuild 才能包含 patch，这里跳过 dist）
import { chromium, firefox } from 'playwright';

const ENDPOINT = process.env.ENDPOINT || 'ws://127.0.0.1:65342';
const BROWSER = process.env.BROWSER || 'Firefox';

if (!ENDPOINT) {
  console.error('❌ 请设置 ENDPOINT 环境变量');
  console.error('   Chrome  CDP: ENDPOINT=ws://127.0.0.1:PORT/devtools/browser/xxx');
  console.error('   Firefox BiDi: ENDPOINT=ws://127.0.0.1:PORT/session');
  process.exit(1);
}

console.log(`🔌 正在连接 ${BROWSER} ...`);
console.log(`   端点: ${ENDPOINT}`);

const browserType = BROWSER === 'Firefox' ? firefox : chromium;

let browser;
try {
  // connect() 会通过 patch 自动检测端点类型：
  //   CDP (/devtools/browser/)  → connectOverCDP
  //   BiDi (/session)           → connectOverCDP (服务端重定向到 BiDi)
  //   其他                        → Playwright Server 协议
  browser = await browserType.connect(ENDPOINT, { timeout: 30000 });
  console.log('✅ 连接成功');
  console.log(`   浏览器版本: ${browser.version()}`);
} catch (err) {
  console.error(`❌ 连接失败: ${err.message}`);
  if (err.message?.includes('Maximum number of active sessions')) {
    console.error('   💡 BiDi 只允许一个活跃 session。请重启 Firefox 或等待旧 session 超时。');
  }
  process.exit(1);
}

// 确保进程退出时正确关闭浏览器（释放 BiDi session）
process.on('exit', () => {
  if (browser) browser.close().catch(() => {});
});
process.on('SIGINT', () => {
  if (browser) browser.close().catch(() => {});
  process.exit(0);
});

let context;
let page;
try {
  // 使用已有 context 或新建（禁用 viewport 以跳过 Firefox 不支持的 emulation 命令）
  context = browser.contexts().length
    ? browser.contexts()[0]
    : await browser.newContext({ locale: 'zh-CN' });

  console.log('📄 正在打开 https://www.baidu.com ...');
  page = await context.newPage();
  await page.goto('https://www.baidu.com', { waitUntil: 'domcontentloaded', timeout: 15000 });

  const title = await page.title();
  console.log(`✅ 页面标题: "${title}"`);

  // 截个图存到 test/ 目录
  await page.screenshot({ path: 'test/baidu_screenshot.png', fullPage: false });
  console.log('📸 截图已保存到 test/baidu_screenshot.png');

  // 尝试搜索框（百度首页的 input#kw）
  const searchInput = await page.$('#kw');
  if (searchInput) {
    console.log('⌨️  在搜索框输入 "Playwright BiDi" ...');
    await searchInput.fill('Playwright BiDi');
    const searchBtn = await page.$('#su');
    if (searchBtn) {
      await searchBtn.click();
      await page.waitForTimeout(2000);
      const resultTitle = await page.title();
      console.log(`✅ 搜索结果页标题: "${resultTitle}"`);
    }
  } else {
    console.log('⚠️  未找到搜索框，尝试截图');
    await page.screenshot({ path: 'test/baidu_page.png', fullPage: true });
  }
} catch (err) {
  console.error(`❌ 页面操作失败: ${err.message}`);
} finally {
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  console.log('👋 已关闭连接');
}
