// 验证 #7：performActions 卡死期间，并发 handleUserPrompt 能否救场
// --------------------------------------------------------------------------
// 组 A 已证：performActions 点击 alert 按钮 -> 命令卡死，但 userPromptOpened
// 事件仍投递到客户端。本脚本验证：在 performActions 卡死期间，**并发**发
// browsingContext.handleUserPrompt 关闭 modal，能否让 performActions 解卡返回。
//
// 若能 -> 现有 race 方案只需补"并发发 handleUserPrompt"，无需放弃 performActions。
// 若不能 -> performActions 卡死占坑，必须改用 script.click 绕过（方案 B）。
//
// 运行：node examples/bidi-repro/07-performactions-rescue.mjs
import { launchRawBiDi, newTabAndNavigate, startFixtureServer } from "./_bidi-harness.mjs";

const { server, PREFIX } = await startFixtureServer();
server.set("/", (_q, r) => {
  r.setHeader("content-type", "text/html");
  r.end(`<button id="b" onclick="alert('boom')">boom</button>`);
});

const { bidi, cleanup } = await launchRawBiDi("07-performactions-rescue");
await bidi.send("session.subscribe", { events: ["browsingContext.userPromptOpened"] });
bidi.on("browsingContext.userPromptOpened", (p) => {
  console.log("  [event] userPromptOpened:", p.type, "handler=", p.handler);
});

try {
  const ctx = await newTabAndNavigate(bidi, `${PREFIX}/`);
  await new Promise((r) => setTimeout(r, 300));

  const pt = await bidi.send("script.callFunction", {
    functionDeclaration: String.raw`() => { const r = document.getElementById('b').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); }`,
    target: { context: ctx }, awaitPromise: false, arguments: []
  });
  const raw = pt.result?.value ?? pt.result;
  const str = typeof raw === "string" ? raw : raw?.value ?? raw;
  const { x, y } = JSON.parse(str);

  console.log("[step] 发 performActions（会卡）+ 1.5s 后并发 handleUserPrompt...");
  const t0 = Date.now();
  const performP = bidi.sendTimed("input.performActions", {
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
  }, 15000);

  // 等 modal 弹出 + 事件投递
  await new Promise((r) => setTimeout(r, 1500));
  console.log("[step] 此时并发发 handleUserPrompt(accept)...");
  const tH = Date.now();
  try {
    await bidi.sendTimed("browsingContext.handleUserPrompt", { context: ctx, accept: true }, 6000);
    console.log(`[rescue] handleUserPrompt returned in ${Date.now() - tH}ms`);
  } catch (e) {
    console.log(`[rescue] handleUserPrompt HUNG: ${e.message} (after ${Date.now() - tH}ms)`);
  }

  // 看 performActions 是否被救活
  console.log("[step] 等 performActions 返回...");
  try {
    const r = await performP;
    console.log(`[RESULT] performActions 返回 in ${r.elapsedMs}ms -> ✅ handleUserPrompt 救场成功`);
  } catch (e) {
    console.log(`[RESULT] performActions 仍卡: ${e.message} (after ${Date.now() - t0}ms) -> ❌ 必须改用 script.click`);
  }
} finally {
  server.close();
  await cleanup();
}
console.log("[done] repro #7");
