// Shared harness for the 5 BiDi repro scripts.
//
// 用途：拉起一个真实的 RoxyBrowser Firefox，建一条“裸 BiDi WebSocket”——不经过
// 本项目的 any 适配器/封装，直接发原始 WebDriver BiDi 命令。这样内核工程师可以在
// 最小复现层面（纯协议）确认问题，排除本适配器的干扰。
//
// 依赖：.env 里有 ROXYBROWSER_API_TOKEN（与 mcp-parity 测试一致）。
// 环境变量：
//   ROXYBROWSER_API_PORT          API 端口（默认 50000）
//   ROXYBROWSER_CORE_VERSION      Firefox 内核版本（默认 146）
//   ROXYBROWSER_PROFILE_NAME      profile 名（默认 Bidi Repro）
//   ROXYBROWSER_WINDOW_REMARK     窗口备注（默认 bidi repro）
//   BIDI_PROBO_PROFILE_REUSE      =1 时不删 profile（方便反复复现）

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import http from "node:http";
import { openRoxyBrowserFirefoxBidiProfile, closeRoxyBrowserFirefoxBidiProfile } from "../../scripts/roxybrowser-firefox-bidi.mjs";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) loadEnvFile(envPath);

const API_PORT = process.env.ROXYBROWSER_API_PORT ?? "50000";
const API_TOKEN = process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
const WORKSPACE_ID = process.env.ROXYBROWSER_WORKSPACE_ID;
const CORE_VERSION = process.env.ROXYBROWSER_CORE_VERSION ?? "146";

if (!API_TOKEN) {
  throw new Error("Missing ROXYBROWSER_API_TOKEN in .env (set it like the mcp-parity tests).");
}

// ---- 极简裸 BiDi client（WS framing + id/message 分发）----
// 我们故意不复用 src/protocol/bidi/client.ts，避免“是不是适配器 bug”的争议。
// 内核工程师审阅时只需看这里 ~60 行。用 Node 22+ 内置的 global WebSocket（无需 ws 包）。
export class RawBiDi {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    // ws 包用 EventEmitter(on/once)。我们故意不复用 src bidi client，保持裸协议层。
    ws.on("message", (data) => this.#onMessage(typeof data === "string" ? data : data.toString("utf8")));
    ws.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("ws closed"));
      this.pending.clear();
    });
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === "success" || msg.type === "error") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === "success") p.resolve(msg.result);
      else p.reject(new Error(`${msg.error}: ${msg.message ?? ""} (method=${p.method})`));
      return;
    }
    // event: msg.type === "event"
    const ls = this.listeners.get(msg.method);
    if (ls) for (const l of ls) l(msg.params);
  }

  on(method, listener) {
    const s = this.listeners.get(method) ?? new Set();
    s.add(listener);
    this.listeners.set(method, s);
    return () => s.delete(listener);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { method, resolve: resolvePromise, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // send with a hard timeout — 用来证明“命令发出去后多久没回”。
  sendTimed(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    const start = Date.now();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`TIMEOUT after ${timeoutMs}ms waiting for ${method} (elapsed=${Date.now() - start}ms)`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (r) => { clearTimeout(timer); resolvePromise({ result: r, elapsedMs: Date.now() - start }); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

export async function launchRawBiDi(label) {
  const tag = label ?? "Bidi Repro";
  console.log(`[harness] opening RoxyBrowser Firefox BiDi profile (${tag})...`);
  const session = await openRoxyBrowserFirefoxBidiProfile({
    apiPort: API_PORT,
    apiToken: API_TOKEN,
    workspaceId: WORKSPACE_ID,
    createNewProfile: true,
    profileName: process.env.ROXYBROWSER_PROFILE_NAME ?? `RoxyBrowser ${tag}`,
    windowRemark: process.env.ROXYBROWSER_WINDOW_REMARK ?? tag.toLowerCase(),
    coreType: "Firefox",
    coreVersion: CORE_VERSION,
    debug: false
  });
  console.log(`[harness] endpoint=${session.endpoint} sessionId=${session.sessionId ?? "<none>"}`);

  // 解析 ws 包（geckodriver 的 BiDi 端点用 ws@8 能握手机；ws@7/Node 内置 undici
  // WebSocket 会 fail）。优先 ws@8，其次 hoist 的 ws，最后兜底。pnpm 把它放在
  // .pnpm/node_modules/ws 与 .pnpm/ws@8.x/node_modules/ws。
  const { createRequire } = await import("node:module");
  const { resolve: pathResolve } = await import("node:path");
  const req = createRequire(pathResolve("examples/bidi-repro/index.js"));
  const candidates = [
    pathResolve("node_modules/.pnpm/ws@8.21.0/node_modules/ws"),
    pathResolve("node_modules/.pnpm/node_modules/ws"),
    pathResolve("node_modules/ws"),
    "ws"
  ];
  let WebSocketCtor = null;
  let lastErr;
  for (const c of candidates) {
    try {
      const m = req(c);
      const v = m.WebSocket ?? m;
      if (v && typeof v === "function") { WebSocketCtor = v; break; }
    } catch (e) { lastErr = e; }
  }
  if (!WebSocketCtor) throw new Error(`Could not resolve 'ws' for BiDi harness. Run: pnpm add -D ws. (${lastErr?.message})`);

  // geckodriver 的 BiDi WS 端点在 /session（或 /session/<id>)，不是 /。连 / 会得
  // "Unexpected server response: 200"。和本项目 normalizeFirefoxBidiEndpoint 一致。
  const wsUrl = new URL(session.endpoint);
  if (session.sessionId) {
    wsUrl.pathname = `/session/${session.sessionId}`;
  } else if (wsUrl.pathname === "/" || wsUrl.pathname === "") {
    wsUrl.pathname = "/session";
  }
  console.log(`[harness] wsUrl=${wsUrl.toString()}`);
  const ws = new WebSocketCtor(wsUrl.toString());
  await new Promise((res, rej) => {
    if (ws.readyState === 1 /* OPEN */) return res();
    ws.once("open", res);
    ws.once("error", (e) => rej(new Error(`ws connect to ${wsUrl} failed: ${e?.message ?? e}`)));
  });

  const bidi = new RawBiDi(ws);

  // geckodriver 每个 Firefox 实例只允许 1 个 BiDi session；RoxyBrowser 拉起的
  // Firefox 往往已自带一个 session。这里复用项目里 ensureMcpBiDiSession 的逻辑：
  // 先 session.status，尝试 getTree（用现有 session）；只有“无 session”时才
  // session.new，避免触发 "Maximum number of active sessions"。
  let topLevel = null;
  let topStatus;
  try {
    topStatus = await bidi.send("session.status", {});
  } catch {}
  if (topStatus) console.log(`[harness] session.status: ready=${topStatus.ready ?? "?"}`);
  try {
    // 若已有可用 session，getTree 会成功。
    await bidi.send("browsingContext.getTree", { maxDepth: 0 });
    topLevel = { reused: true };
    console.log(`[harness] reused existing BiDi session (getTree ok)`);
  } catch (e) {
    const m = String(e?.message ?? e);
    if (m.includes("session does not exist") || m.includes("invalid session id") || m.includes("not active")) {
      // 没有 session，建一个新的
      topLevel = await bidi.send("session.new", {
        capabilities: { alwaysMatch: { acceptInsecureCerts: true } }
      });
      console.log(`[harness] session.new ok, sessionId=${topLevel.session?.sessionId ?? "?"}`);
    } else {
      throw e;
    }
  }

  const cleanup = async () => {
    bidi.close();
    if (process.env.BIDI_REPRO_PROFILE_REUSE === "1") return;
    await closeRoxyBrowserFirefoxBidiProfile({
      apiPort: API_PORT,
      apiToken: API_TOKEN,
      workspaceId: WORKSPACE_ID,
      dirId: session.dirId,
      deleteProfile: true
    }).catch(() => {});
  };

  return { bidi, session, cleanup };
}

// 方便每个脚本起一个干净的顶级 browsing context 并导航。
export async function newTabAndNavigate(bidi, url) {
  const res = await bidi.send("browsingContext.create", { type: "tab" });
  const context = res.context;
  await bidi.send("browsingContext.navigate", { context, url, wait: "complete" });
  return context;
}

// 一个本地 HTTP 夹具页 server，按需返回 HTML。避免依赖外部站点。
export function startFixtureServer() {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      const handlers = server.__handlers?.[url];
      if (handlers) {
        Promise.resolve(handlers(req, res)).catch(() => res.end());
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    server.__handlers = {};
    server.set = (path, handler) => { server.__handlers[path] = handler; };
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveServer({ server, PREFIX: `http://127.0.0.1:${port}` });
    });
  });
}
