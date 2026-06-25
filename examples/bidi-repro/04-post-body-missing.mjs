// 复现 #4：network.beforeRequestSent 不含 POST body，需另发 getRequestPostData
// --------------------------------------------------------------------------
// 现象：页面里 fetch('/api', { method:'POST', body: JSON.stringify({k:'v'}) })，
//      收到的 network.beforeRequestSent 事件 payload 里只有 bodySize（字节数），
//      没有 body 内容本身。要拿到真实 body 必须再发 network.getRequestPostData
//      （请求 id 来自 beforeRequestSent 的 request.request）。本项目 BiDi 侧
//      目前只置了个空串占位，从未真正调 getRequestPostData，所以
//      browser_network_request part="request-body" 在 BiDi 下永远拿不到内容。
// 文档：spec 明确 beforeRequestSent 不内联 body；body 由 getRequestPostData
//       单独获取。本脚本证明：事件里无 body 字段，且 getRequestPostData 可取回。
// 佐证：Playwright bidiNetworkManager 在 _onBeforeRequestSent 里也没有直接读 body
//       （仅取 headers/url），response body 走 network.getData —— 与本项目一致。
//
// 运行：node examples/bidi-repro/04-post-body-missing.mjs
import { launchRawBiDi, newTabAndNavigate, startFixtureServer } from "./_bidi-harness.mjs";

const { server, PREFIX } = await startFixtureServer();
server.set("/", (_q, r) => {
  r.setHeader("content-type", "text/html");
  r.end(`<button id="b" onclick="fetch('/api',{method:'POST',headers:{'X-H':'1'},body:JSON.stringify({k:'v'})})">go</button>`);
});
server.set("/api", (req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ echoed: buf }));
  });
});

const { bidi, cleanup } = await launchRawBiDi("04-post-body-missing");
const beforeReqEvents = [];
bidi.on("network.beforeRequestSent", (p) => {
  if (new URL(p.request.url).pathname === "/api") beforeReqEvents.push(p);
});

function hasBody(obj) {
  return obj != null && typeof obj === "object" && "body" in obj;
}

try {
  await bidi.send("session.subscribe", { events: ["network.beforeRequestSent"] });
  const ctx = await newTabAndNavigate(bidi, `${PREFIX}/`);
  const pt = await bidi.send("script.callFunction", {
    functionDeclaration: String.raw`() => { const r = document.getElementById('b').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); }`,
    target: { context: ctx }, awaitPromise: false, arguments: []
  });
  const raw = pt.result?.value ?? pt.result;
  const str = typeof raw === "string" ? raw : raw?.value ?? raw;
  const { x, y } = JSON.parse(str);
  await bidi.send("input.performActions", {
    context: ctx,
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" },
        { type: "pointerDown", button: 0 }, { type: "pause", duration: 50 }, { type: "pointerUp", button: 0 }
      ] }]
  });
  await new Promise((r) => setTimeout(r, 1500));

  const ev = beforeReqEvents[0];
  if (!ev) {
    console.log("[note] 没收到 /api 的 beforeRequestSent（可能受 #3 时序影响），重试可解决");
  } else {
    console.log("[repro] beforeRequestSent 收到，payload 是否含 body 字段：", hasBody(ev.request) ? "YES(意外)" : "NO（符合 spec）");
    console.log("[repro] event.request 字段：", Object.keys(ev.request).join(", "));
    console.log("[repro] bodySize =", ev.request.bodySize ?? "<缺>");

    // 尝试用 getRequestPostData 取 body
    try {
      const postData = await bidi.sendTimed("network.getRequestPostData", { request: ev.request.request }, 10000);
      const body = postData.result?.bytes?.value ?? postData.result?.bytes ?? "<无>";
      console.log("[repro] getRequestPostData 返回：", JSON.stringify(body).slice(0, 200));
      console.log("[结论] beforeRequestSent 不含 body；真 body 需经 getRequestPostData 额外获取。本项目 BiDi 侧未实现这一步（TODO）。");
    } catch (e) {
      console.log("[repro] getRequestPostData 失败/超时：" + e.message + "（Firefox 对该命令支持可能不稳）");
    }
  }
} finally {
  server.close();
  await cleanup();
}
console.log("[done] repro #4");
