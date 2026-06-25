// 复现 #1：点击触发同步 alert() 后，input.performActions 永不 resolve
// --------------------------------------------------------------------------
// 现象：对一个 onclick=alert('x') 的按钮做 BiDi input.performActions，
//      pointerUp 释放那一刻页面弹出同步 alert，performActions 这个命令
//      永远不返回其 success 响应（实测 60s 仍卡着，靠超时退出）。
//      CDP 下只有 mouseRelease 那一步会阻塞，且能被 dialog waiter race 掉；
//      BiDi 把整段 pointer 序列做成一个原子命令，无法中途 race。
// 文档：W3C 规范并未规定 performActions 在 user prompt 打开时的行为，
//       只规定 userPromptOpened 事件会被发射。Firefox/geckodriver 的实现
//       选择“阻塞 performActions 直至 modal 被处理”，未在规范中明确。
// 佐证：Playwright bidi（third_party）也只在 dialogDidOpen 里用
//       handleUserPrompt 关闭，并未在 performActions 层 race。
//
// 运行：node examples/bidi-repro/01-click-alert-blocks.mjs
import { launchRawBiDi, newTabAndNavigate, startFixtureServer } from "./_bidi-harness.mjs";

const { server, PREFIX } = await startFixtureServer();
server.set("/", (_q, r) => {
  r.setHeader("content-type", "text/html");
  r.end(`<button id="b" onclick="alert('boom')">boom</button>`);
});

const { bidi, cleanup } = await launchRawBiDi("01-click-alert-blocks");
const captured = [];
bidi.on("browsingContext.userPromptOpened", (p) => {
  captured.push(p);
  console.log("[event] userPromptOpened:", JSON.stringify(p).slice(0, 120));
});

try {
  const ctx = await newTabAndNavigate(bidi, `${PREFIX}/`);
  // 拿到按钮中心坐标。BiDi 的 script.callFunction 返回序列化 RemoteValue，
  // 这里直接返回 JSON 字符串再解析，避免处理序列化结构。
  const pt = await bidi.send("script.callFunction", {
    functionDeclaration: String.raw`() => { const r = document.getElementById('b').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); }`,
    target: { context: ctx },
    awaitPromise: false,
    arguments: []
  });
  const raw = pt.result?.value ?? pt.result;
  const str = typeof raw === "string" ? raw : raw?.value ?? raw;
  const { x, y } = JSON.parse(str);
  console.log("[step] button center:", x, y);

  // 关键：performActions 里 pointerUp 会触发 alert()
  console.log("[step] sending input.performActions (expect it to HANG)...");
  const t0 = Date.now();
  try {
    const { elapsedMs } = await bidi.sendTimed("input.performActions", {
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
    }, 20000); // 20s 超时，足以证明“没在正常时间返回”
    console.log(`[RESULT-OK?] performActions returned in ${elapsedMs}ms WITHOUT timeout`);
  } catch (e) {
    console.log(`[REPRO] ${e.message} (after ${Date.now() - t0}ms) -> 命令未在预期时间内返回`);
  }
  console.log("[detail] userPromptOpened 事件个数:", captured.length,
    captured.length === 0 ? "(0 = 事件都没来，说明命令根本卡住连事件都发不出/收不到)" : "(事件到达，但命令仍不返回)");
} finally {
  server.close();
  await cleanup();
}
console.log("[done] repro #1");
