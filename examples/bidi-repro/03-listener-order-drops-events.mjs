// 复现 #3：sessionSubscribe 之后、attachListeners 之前到达的事件被静默丢弃
// --------------------------------------------------------------------------
// 现象（项目侧调试观察）：把 sessionSubscribe 放在 attachListeners 之前时，
//      调试日志里出现连续几十个 [DEBUG bidi client no-listener] network.beforeRequestSent，
//      即订阅刚成功、监听器未注册时，Firefox 已推送的事件被静默丢弃。
//      这是协议层“事件 fire-and-forget、无重放”导致的客户端竞态——
//      项目里改为“先 attach 监听器再 subscribe”后该现象消失。
//
// 真实复现结果（此脚本，对比两种顺序）：
//   listener-first 与 subscribe-first 均捕获 4/4 个图片请求，未观察到丢失。
//   说明：在本机当前 Firefox/geckodriver 时序下，"先 subscribe 再 attach"
//        的竞态窗口极小、本次未命中。这是非确定性的（受机器调度影响），
//        项目侧的修复（先 attach 再 subscribe）是更安全的写法，应保留。
//        本脚本用以在不同机器/负载下尝试命中，便于内核工程师评估时序窗口。
//
// 运行：node examples/bidi-repro/03-listener-order-drops-events.mjs
import { launchRawBiDi, startFixtureServer } from "./_bidi-harness.mjs";

const { server, PREFIX } = await startFixtureServer();
// 一个会发若干子资源请求的页面
server.set("/", (_q, r) => {
  r.setHeader("content-type", "text/html");
  r.end(`<img src="/a.png"><img src="/b.png"><img src="/c.png"><img src="/d.png">`);
});
for (const p of ["/a.png", "/b.png", "/c.png", "/d.png"]) {
  server.set(p, (_q, r) => { r.setHeader("content-type", "image/png"); r.end(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])); });
}

async function trial(order) {
  const captured = [];
  const { bidi, cleanup } = await launchRawBiDi(`03-order-${order}`);

  const wsListener = (p) => { if (/^\/[abcd]\.png$/.test(new URL(p.request.url).pathname)) captured.push(p.request.url); };

  if (order === "subscribe-first") {
    await bidi.send("session.subscribe", { events: ["network.beforeRequestSent"] });
    bidi.on("network.beforeRequestSent", wsListener);
  } else {
    bidi.on("network.beforeRequestSent", wsListener);
    await bidi.send("session.subscribe", { events: ["network.beforeRequestSent"] });
  }

  // 创建 tab 并导航（触发 a/b/c/d.png 请求）
  const res = await bidi.send("browsingContext.create", { type: "tab" });
  await bidi.send("browsingContext.navigate", { context: res.context, url: `${PREFIX}/`, wait: "complete" });
  await new Promise((r) => setTimeout(r, 1500)); // 等所有资源事件

  const got = [...new Set(captured.map((u) => new URL(u).pathname))]
    .filter((x) => ["/a.png","/b.png","/c.png","/d.png"].includes(x));
  console.log(`[trial ${order}] captured image requests: ${got.length}/4  -> ${got.join(",") || "(none)"}`);
  await cleanup();
  return got.length;
}

try {
  console.log("对比两种监听器注册顺序对网络事件捕获的影响：");
  // 先做 listener-first（安全顺序）
  const safe = await trial("listener-first");
  // 再做 subscribe-first（危险顺序，预期丢更多）
  const risky = await trial("subscribe-first");
  console.log(`\n[结论] listener-first 捕获 ${safe}/4，subscribe-first 捕获 ${risky}/4。`);
  console.log("       若 subscribe-first 明显更少，即复现了“事件在监听器就位前到达被丢弃”。");
  console.log("       （注：行为受时序影响，可能非确定性；多次运行可观察到 subscribe-first 偶发丢失）");
} finally {
  server.close();
}
console.log("[done] repro #3");
