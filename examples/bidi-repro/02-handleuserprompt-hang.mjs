// 复现 #2：modal 打开期间 browsingContext.handleUserPrompt 长时间不返回
// --------------------------------------------------------------------------
// 现象（项目侧实测）：先用脚本注入 alert() 打开 modal（不靠 click，排除 #1 的干扰），
//      然后立即发 browsingContext.handleUserPrompt。命令长时间不返回
//      （60s+，靠 MCP 客户端超时或本脚本超时才解脱）。后续任何 BiDi 命令
//      （如 browsingContext.getTree）在同一 modal 期间也一并被卡住。
//
// 重要说明（实测后的真实结果）：
//   在“纯协议”最小复现里，用 script.callFunction 触发 alert()，bi
//   浏览器侧的 prompt 经常在 handleUserPrompt 发出之前就已被关闭，导致
//   handleUserPrompt 很快返回（甚至 getTree 也很快）——看起来“不复现”。
//   这并不能证明 modal-下-handleUserPrompt 不卡，而是因为：
//     a) geckodriver/Firefox 在 alert 持续期间会卡住之前那个 script.callFunction
//        的响应（同步 alert 阻塞脚本执行线程），所以从客户端看
//        “注入 alert 的那次调用本身就先卡住”，等它返回时 modal 已被人/超时关掉；
//     b) 当真的需要“主动 handleUserPrompt 关闭 modal”时（即 #1 click 场景），
//        performActions 已先一步卡死，根本到不了 handleUserPrompt。
//   所以 #2 与 #1 同根：Firefox 在 JS 同步 modal 打开期间会阻塞 BiDi 命令派发。
//   #1 是这个根因最干净的复现（performActions 在 pointerUp 时卡死）。
//   本脚本保留，输出会显示“注入 alert 的调用先卡住 handleUserPrompt 反而很快返回”
//   这一观察，作为给内核工程师的旁证。
//
// 佐证：Playwright DialogManager.dialogDidOpen 里有一段
//       `if (!hasHandlers) dialog._close()` ——没有用户 handler 时立即自动
//       关闭 dialog，正是为了规避“modal 一直开着把后续命令全卡死”。
//
// 运行：node examples/bidi-repro/02-handleuserprompt-hang.mjs
import { launchRawBiDi, newTabAndNavigate, startFixtureServer } from "./_bidi-harness.mjs";

const { server, PREFIX } = await startFixtureServer();
server.set("/", (_q, r) => { r.setHeader("content-type", "text/html"); r.end(`<div></div>`); });

const { bidi, cleanup } = await launchRawBiDi("02-handleuserprompt-hang");
bidi.on("browsingContext.userPromptOpened", (p) => console.log("[event] userPromptOpened:", p.context, p.type));

try {
  const ctx = await newTabAndNavigate(bidi, `${PREFIX}/`);
  // 用 eval 注入 alert（setTimeout 推迟，避免阻塞 callFunction 响应本身）
  console.log("[step] injecting alert via script.callFunction (expect THIS call itself to stall while modal open)...");
  const tInject = Date.now();
  let injectHung = false;
  try {
    await bidi.sendTimed("script.callFunction", {
      functionDeclaration: String.raw`() => { setTimeout(() => alert("hi"), 0); return 1; }`,
      target: { context: ctx }, awaitPromise: false, arguments: []
    }, 8000);
    console.log(`[note] inject call returned in ${Date.now() - tInject}ms`);
  } catch (e) {
    injectHung = true;
    console.log(`[REPRO] inject call itself stalled/hung: ${e.message} (after ${Date.now() - tInject}ms)`);
  }
  await new Promise((r) => setTimeout(r, 600));

  console.log("[step] sending handleUserPrompt(accept)...");
  const t0 = Date.now();
  let promptSeen = false;
  try {
    const { elapsedMs } = await bidi.sendTimed("browsingContext.handleUserPrompt",
      { context: ctx, accept: true }, 10000);
    console.log(`[RESULT] handleUserPrompt returned in ${elapsedMs}ms`);
    promptSeen = true;
  } catch (e) {
    console.log(`[REPRO] handleUserPrompt did not return: ${e.message} (after ${Date.now() - t0}ms)`);
  }

  console.log("[step] now sending browsingContext.getTree (if modal still open, expect hang)...");
  const t1 = Date.now();
  try {
    await bidi.sendTimed("browsingContext.getTree", { maxDepth: 0 }, 10000);
    console.log(`[note] getTree returned in ${Date.now() - t1}ms (modal likely already closed)`);
  } catch (e) {
    console.log(`[REPRO] getTree ALSO hung: ${e.message} -> 整条 BiDi 通道在 modal 期间被阻塞`);
  }
  console.log(`\n[小结] injectHung=${injectHung} promptSeen=${promptSeen}。` +
    `若 injectHung=true 或 getTree hung，即旁证“modal 期间 BiDi 命令派发被阻塞”（与 #1 同根）。`);
} finally {
  server.close();
  await cleanup();
}
console.log("[done] repro #2");
