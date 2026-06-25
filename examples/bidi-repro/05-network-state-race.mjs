// 复现 #5：网络事件时序——本适配器侧读取竞态 vs 协议层是否固有抖动
// --------------------------------------------------------------------------
// 项目侧观察：点击触发 fetch('/api') 后，连续 browser_network_requests罗列，
// /api 的“存在性”与“status 有无”偶尔抖动，导致无法强一致断言（=> [200] OK 全匹配）。
//
// 真实复现结果（裸协议层 + 按 requestId 去重）：
//   连续 8 次快照里 /api 始终存在、status 始终为 200，未观察到抖动。
//   说明：BiDi 协议层在正确去重下是稳定的；项目侧的抖动来自于
//   “waitForNetworkRequest 在 beforeRequestSent 已到、responseCompleted 未到时
//    就匹配返回”，随后 adapter 内部 ensureNetworkRequest/responseCompleted 之间
//    存在中间态窗口，对外读取到无 status 的瞬态。这是 adapter 端的读取时机问题，
//    不是 BiDi 协议固有缺陷。
//
// 所以本脚本用来“证伪抖动是协议层固有的”，并量化：若裸协议也抖动→协议层问题；
// 若不抖动→问题在 adapter 读取时机。实测结论是后者。
//
// 运行：node examples/bidi-repro/05-network-state-race.mjs
import { launchRawBiDi, newTabAndNavigate, startFixtureServer } from "./_bidi-harness.mjs";

const { server, PREFIX } = await startFixtureServer();
server.set("/", (_q, r) => {
  r.setHeader("content-type", "text/html");
  r.end(`<button id="b" onclick="fetch('/api',{method:'POST',body:JSON.stringify({k:'v'})})">go</button>`);
});
server.set("/api", (req, res) => {
  let buf = ""; req.on("data", (c) => (buf += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ echoed: buf })); });
});

const { bidi, cleanup } = await launchRawBiDi("05-network-state-race");
const state = new Map(); // requestId -> {method,url,status?,ts}
bidi.on("network.beforeRequestSent", (p) => {
  state.set(p.request.request, { method: p.request.method, url: p.request.url, ts: p.timestamp, status: undefined });
});
bidi.on("network.responseCompleted", (p) => {
  const e = state.get(p.request.request);
  if (e) e.status = p.response?.status;
});

function snapshot() {
  const arr = [...state.values()].filter((r) => new URL(r.url).host === new URL(PREFIX).host);
  const api = arr.find((r) => r.url.endsWith("/api"));
  return { count: arr.length, api: api ? `${api.method} ${new URL(api.url).pathname} status=${api.status ?? "<空>"}` : "<缺失>", all: arr.map((r) => `${r.method} ${new URL(r.url).pathname}(${r.status ?? "-"})`).join(" ") };
}

try {
  await bidi.send("session.subscribe", { events: ["network.beforeRequestSent", "network.responseCompleted"] });
  const ctx = await newTabAndNavigate(bidi, `${PREFIX}/`);
  const pt = await bidi.send("script.callFunction", {
    functionDeclaration: String.raw`() => { const r = document.getElementById('b').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); }`,
    target: { context: ctx }, awaitPromise: false, arguments: []
  });
  const raw = pt.result?.value ?? pt.result;
  const str = typeof raw === "string" ? raw : raw?.value ?? raw;
  const { x, y } = JSON.parse(str);
  console.log("[step] click to fire POST /api ...");
  await bidi.send("input.performActions", {
    context: ctx,
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" },
        { type: "pointerDown", button: 0 }, { type: "pause", duration: 50 }, { type: "pointerUp", button: 0 }
      ] }]
  });

  for (let i = 1; i <= 8; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const s = snapshot();
    console.log(`[t+${(i * 150)}ms] count=${s.count} api=${s.api}\n            list: ${s.all}`);
  }
  console.log("\n[结论] 若上面 8 次快照里 /api 的“存在性”或“status 有无”出现过抖动，即复现 #5。");
  console.log("       这使得 BiDi 下无法对网络列表做强一致断言（如 => [200] OK 全匹配）。");
} finally {
  server.close();
  await cleanup();
}
console.log("[done] repro #5");
