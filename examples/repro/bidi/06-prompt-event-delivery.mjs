// 验证：模态框打开期间，geckodriver 能否投递 userPromptOpened 事件
// --------------------------------------------------------------------------
// 这是决定 #1 是否有"适配器层"解决方案的关键实验。
//
// 三个对比组：
//   A) 用 BiDi input.performActions 点击 alert 按钮（原 #1 路径），订阅了事件
//   B) 用 script.callFunction 里 setTimeout(()=>el.click(),0) + awaitPromise:false
//      绕过 performActions 的原子阻塞
//   C) 对照：普通无 alert 按钮的 performActions，确认基线不卡
//
// 关键观察点：
//   1. callFunction(awaitPromise:false) 是否立即返回（不卡）？
//   2. modal 期间 userPromptOpened 事件是否到达客户端？
//   3. 事件到达后，browsingContext.handleUserPrompt 是否能正常关闭 modal？
//
// 运行：node examples/repro/bidi/06-prompt-event-delivery.mjs
import { launchRawBiDi, newTabAndNavigate, startFixtureServer } from "./_bidi-harness.mjs";

const { server, PREFIX } = await startFixtureServer();
server.set("/", (_q, r) => {
  r.setHeader("content-type", "text/html");
  r.end(`
    <button id="alertBtn" onclick="alert('boom')">boom</button>
    <button id="plainBtn" onclick="window.__clicked=true">plain</button>
  `);
});

const { bidi, cleanup } = await launchRawBiDi("06-prompt-event-delivery");

// 关键：先订阅事件，再注册监听器（项目里 initialize 的正确顺序）。
await bidi.send("session.subscribe", {
  events: ["browsingContext.userPromptOpened"]
});
const captured = [];
bidi.on("browsingContext.userPromptOpened", (p) => {
  captured.push(p);
  console.log("  [event] userPromptOpened:", p.context, p.type, JSON.stringify(p).slice(0, 100));
});

function centerViaScript(ctx) {
  return bidi.send("script.callFunction", {
    functionDeclaration: String.raw`(id) => { const r = document.getElementById(id).getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); }`,
    target: { context: ctx }, awaitPromise: false,
    arguments: [{ type: "string", value: "alertBtn" }]
  }).then((pt) => {
    const raw = pt.result?.value ?? pt.result;
    const str = typeof raw === "string" ? raw : raw?.value ?? raw;
    return JSON.parse(str);
  });
}

async function dismissAnyModal(ctx) {
  // 试着关掉可能还开着的 modal，给下一组干净环境
  try {
    await bidi.sendTimed("browsingContext.handleUserPrompt", { context: ctx, accept: true }, 3000);
  } catch {}
}

try {
  const ctx = await newTabAndNavigate(bidi, `${PREFIX}/`);
  await new Promise((r) => setTimeout(r, 300));

  // ---- 组 B：script.click 绕过 performActions ----
  console.log("\n=== 组 B: script.callFunction(setTimeout click) + awaitPromise:false ===");
  captured.length = 0;
  const tB = Date.now();
  try {
    const r = await bidi.sendTimed("script.callFunction", {
      functionDeclaration: String.raw`() => { setTimeout(() => document.getElementById('alertBtn').click(), 0); return "scheduled"; }`,
      target: { context: ctx }, awaitPromise: false, arguments: []
    }, 5000);
    console.log(`[B] callFunction returned in ${r.elapsedMs}ms -> ${JSON.stringify(r.result)}`);
  } catch (e) {
    console.log(`[B] callFunction HUNG: ${e.message} (after ${Date.now() - tB}ms)`);
  }
  // 给 modal 弹出 + 事件投递一点时间
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`[B] events captured during modal window: ${captured.length}`);
  console.log(`[B] ${captured.length > 0 ? "✅ 事件能投递 -> 适配器层 race 方案可行" : "❌ 事件未投递 -> 只能靠 unhandledPromptBehavior 自动处理"}`);

  // 尝试用 handleUserPrompt 关闭 modal
  console.log("[B] 尝试 handleUserPrompt(accept) 关闭 modal...");
  const tH = Date.now();
  try {
    const r = await bidi.sendTimed("browsingContext.handleUserPrompt", { context: ctx, accept: true }, 6000);
    console.log(`[B] handleUserPrompt returned in ${r.elapsedMs}ms`);
  } catch (e) {
    console.log(`[B] handleUserPrompt HUNG: ${e.message} (after ${Date.now() - tH}ms) -> 模态期间命令派发被阻塞`);
  }

  // ---- 探针：modal 关闭后，BiDi 通道是否恢复 ----
  console.log("\n=== 探针: getTree 是否恢复 ===");
  const tG = Date.now();
  try {
    await bidi.sendTimed("browsingContext.getTree", { maxDepth: 0 }, 5000);
    console.log(`[probe] getTree returned in ${Date.now() - tG}ms -> 通道${Date.now() - tG < 1000 ? "已恢复" : "慢但可用"}`);
  } catch (e) {
    console.log(`[probe] getTree HUNG: ${e.message} -> 通道仍卡死`);
  }

  // ---- 组 A：原 performActions 路径（订阅状态下重测，看事件是否=0）----
  console.log("\n=== 组 A: input.performActions 点击 alert 按钮（已订阅事件）===");
  await dismissAnyModal(ctx);
  await new Promise((r) => setTimeout(r, 500));
  captured.length = 0;
  const { x, y } = await centerViaScript(ctx);
  const tA = Date.now();
  try {
    const r = await bidi.sendTimed("input.performActions", {
      context: ctx,
      actions: [{
        type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 50 },
          { type: "pointerUp", button: 0 }
        ]
      }]
    }, 12000);
    console.log(`[A] performActions returned in ${r.elapsedMs}ms`);
  } catch (e) {
    console.log(`[A] performActions HUNG: ${e.message} (after ${Date.now() - tA}ms)`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`[A] events captured: ${captured.length}  <- 与原 #1 脚本(=0)对比，验证"是没订阅还是真没投递"`);

  console.log("\n=== 小结 ===");
  console.log("若 B 组事件>0 且 handleUserPrompt 能返回 -> 适配器可改用 script.click + 事件 race 规避");
  console.log("若 B 组事件=0 或 handleUserPrompt 卡死 -> 根因是 geckodriver 模态期阻塞，只能靠 unhandledPromptBehavior");
} finally {
  server.close();
  await cleanup();
}
console.log("[done] repro #6");
