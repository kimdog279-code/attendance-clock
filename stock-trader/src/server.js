// 로컬 웹 대시보드 서버.
// 시작하기.bat이 이 파일을 실행하면 브라우저가 자동으로 열린다.
// 127.0.0.1(내 컴퓨터)에서만 접속 가능 — 외부에서는 접근할 수 없다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { configExists, loadConfig, resetConfigCache, projectRoot, readRawConfig, writeRawConfig } from "./config.js";
import { startEngine } from "./engine.js";

const PORT = 8321;
const UI_DIR = path.join(projectRoot(), "ui");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

// ── 핸드폰(같은 와이파이) 접속 ──────────────────────────────────
function mobileConfig() {
  const raw = readRawConfig();
  return { enabled: raw?.mobile?.enabled === true, pin: raw?.mobile?.pin ?? null };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PIN_PAGE = (wrong) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>주식 매매 프로그램</title>
<style>body{font-family:system-ui,sans-serif;background:#f9f9f7;display:flex;justify-content:center;padding-top:18vh;margin:0}
.box{background:#fff;border:1px solid rgba(0,0,0,.1);border-radius:14px;padding:28px;max-width:300px;text-align:center}
input{font-size:22px;width:140px;text-align:center;letter-spacing:6px;padding:8px;border:1px solid #bbb;border-radius:8px}
button{margin-top:14px;font-size:15px;padding:9px 22px;border:none;border-radius:8px;background:#2a78d6;color:#fff;font-weight:600}
.err{color:#d03b3b;font-size:13px;margin-top:10px}</style></head><body>
<form class="box" method="POST" action="/pin"><h3>📈 주식 매매 프로그램</h3>
<p style="font-size:14px;color:#555">컴퓨터 화면의 [📱 핸드폰 접속] 카드에<br/>표시된 PIN을 입력하세요</p>
<input name="pin" inputmode="numeric" maxlength="6" autofocus autocomplete="off"/><br/>
<button>접속</button>${wrong ? '<div class="err">PIN이 일치하지 않습니다</div>' : ""}</form></body></html>`;

// 외부(같은 와이파이) 접속이면 PIN 쿠키를 검사한다. 통과 못 하면 PIN 페이지 응답.
async function checkMobileAuth(req, res, rawBody) {
  const remote = req.socket.remoteAddress ?? "";
  const isLocal =
    process.env.MOBILE_TEST_FORCE_AUTH !== "1" &&
    (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1");
  if (isLocal) return true;

  const { enabled, pin } = mobileConfig();
  if (!enabled || !pin) {
    res.writeHead(403);
    res.end("Forbidden");
    return false;
  }
  const cookiePin = (req.headers.cookie ?? "").split(";").map((c) => c.trim())
    .find((c) => c.startsWith("stpin="))?.slice(6);
  if (cookiePin === pin) return true;

  const pathname = new URL(req.url, "http://x").pathname;
  if (pathname === "/pin" && req.method === "POST") {
    const entered = decodeURIComponent((rawBody.match(/pin=([^&]*)/) ?? [])[1] ?? "").trim();
    if (entered === pin) {
      res.writeHead(302, {
        "set-cookie": `stpin=${pin}; Max-Age=2592000; HttpOnly; SameSite=Lax; Path=/`,
        location: "/",
      });
      res.end();
      return false;
    }
    await sleep(1000); // 무차별 대입 방지용 지연
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PIN_PAGE(true));
    return false;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PIN_PAGE(false));
  return false;
}

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
}

// ── 자동매매 엔진 관리 (동시 여러 종목) ─────────────────────────
const MAX_ENGINES = 5;
const engines = new Map(); // code → { code, live, strategyLabel, running, stop }
const engineLogs = []; // 모든 엔진의 로그를 한 줄기로 (종목 접두어 포함)

function pushEngineLog(prefix, msg) {
  for (const line of String(msg).split("\n")) {
    if (line.trim() === "") continue;
    engineLogs.push(prefix + line);
  }
  if (engineLogs.length > 400) engineLogs.splice(0, engineLogs.length - 400);
  console.log(prefix + msg);
}

async function startEngineBg(code, live, strategy) {
  if (engines.get(code)?.running) throw new Error("이 종목은 이미 자동매매 중입니다.");
  const runningCount = [...engines.values()].filter((e) => e.running).length;
  if (runningCount >= MAX_ENGINES) {
    throw new Error(`자동매매는 동시에 ${MAX_ENGINES}종목까지만 가능합니다. 다른 종목을 먼저 정지해주세요.`);
  }
  const { STRATEGIES } = await import("./strategies.js");
  const id = strategy?.id && STRATEGIES[strategy.id] ? strategy.id : "sma";
  const params = strategy?.params ?? { short: 5, long: 20 };
  let stopResolver;
  const stopPromise = new Promise((resolve) => (stopResolver = resolve));
  const ent = {
    code, live, running: true, stop: stopResolver,
    strategyLabel: STRATEGIES[id].label(params),
  };
  engines.set(code, ent);
  const log = (msg) => pushEngineLog(`[${code}] `, msg);
  startEngine({ code, live, stopPromise, strategy: { id, params }, log })
    .catch((err) => log(`엔진 오류로 중단: ${err.message}`))
    .finally(() => {
      ent.running = false;
    });
}

function engineStatus() {
  const list = [...engines.values()].map((e) => {
    let position = null;
    try {
      position = JSON.parse(
        fs.readFileSync(path.join(projectRoot(), "data", `engine-${e.code}.json`), "utf8")
      ).position;
    } catch {}
    return { code: e.code, live: e.live, running: e.running, strategyLabel: e.strategyLabel, position };
  });
  return { engines: list, running: list.some((e) => e.running), logs: engineLogs.slice(-50) };
}

// ── API 핸들러 ─────────────────────────────────────────────────
async function handleApi(req, res, pathname, body) {
  const q = new URL(req.url, "http://x").searchParams;
  const code = (q.get("code") ?? body?.code ?? "005930").trim();

  if (pathname === "/api/status") {
    const raw = readRawConfig();
    const out = {
      version: appVersion(),
      configured: false,
      mode: raw?.mode === "real" ? "real" : "paper",
      profiles: { paper: !!raw?.paper?.appKey || !!raw?.appKey, real: !!raw?.real?.appKey },
      settings: {
        allowRealOrders: raw?.allowRealOrders === true,
        allowRealAutoTrade: raw?.allowRealAutoTrade === true,
        maxOrderAmount: Number(raw?.maxOrderAmount ?? 100000),
        autoTradeBudget: Number(raw?.autoTradeBudget ?? 1000000),
        dailyLossLimit: Number(raw?.dailyLossLimit ?? 100000),
        maxDailyOrders: Number(raw?.maxDailyOrders ?? 6),
      },
      engine: engineStatus(),
    };
    if (configExists()) {
      try {
        out.mode = loadConfig().mode;
        out.configured = true;
      } catch {}
    }
    return out;
  }

  if (pathname === "/api/setup" && req.method === "POST") {
    const target = body.target === "real" ? "real" : "paper";
    let accountNo = String(body.accountNo ?? "").trim().replaceAll(" ", "");
    if (/^\d{8}$/.test(accountNo)) accountNo += "-01";
    if (!/^\d{8}-\d{2}$/.test(accountNo)) throw new Error("계좌번호는 숫자 8자리로 입력해주세요.");
    const appKey = String(body.appKey ?? "").trim();
    const appSecret = String(body.appSecret ?? "").trim();
    if (!appKey || appSecret.length < 20) throw new Error("APP Key 또는 APP Secret이 비어 있거나 너무 짧습니다.");

    const raw = readRawConfig() ?? {};
    delete raw.appKey; delete raw.appSecret; delete raw.accountNo; // 구버전 잔재 제거
    raw[target] = { appKey, appSecret, accountNo };
    raw.mode = target;
    raw.allowRealOrders = raw.allowRealOrders === true; // 실전 키를 넣어도 주문 허용은 별도 스위치
    raw.maxOrderAmount = Number(raw.maxOrderAmount ?? 100000);
    raw.autoTradeBudget = Number(raw.autoTradeBudget ?? 1000000);
    writeRawConfig(raw);

    const { getPrice } = await import("./api/quotations.js");
    const p = await getPrice("005930");
    return { ok: true, samplePrice: p.price };
  }

  if (pathname === "/api/mode" && req.method === "POST") {
    const want = body.mode === "real" ? "real" : "paper";
    const raw = readRawConfig();
    if (!raw) throw new Error("설정이 없습니다. 먼저 키를 등록해주세요.");
    if (want === "real" && !raw.real?.appKey) return { needsKeys: true };
    if ([...engines.values()].some((e) => e.running)) {
      throw new Error("자동매매가 실행 중입니다. 먼저 정지한 뒤 모드를 전환해주세요.");
    }
    raw.mode = want;
    writeRawConfig(raw);
    return { ok: true, mode: want };
  }

  if (pathname === "/api/settings" && req.method === "POST") {
    const raw = readRawConfig();
    if (!raw) throw new Error("설정이 없습니다.");
    if (typeof body.allowRealOrders === "boolean") raw.allowRealOrders = body.allowRealOrders;
    if (typeof body.allowRealAutoTrade === "boolean") raw.allowRealAutoTrade = body.allowRealAutoTrade;
    if (body.maxOrderAmount != null) {
      const v = Number(body.maxOrderAmount);
      if (!Number.isFinite(v) || v < 0) throw new Error("주문 상한 금액이 올바르지 않습니다.");
      raw.maxOrderAmount = v;
    }
    if (body.autoTradeBudget != null) {
      const v = Number(body.autoTradeBudget);
      if (!Number.isFinite(v) || v < 10000) throw new Error("자동매매 예산은 1만원 이상이어야 합니다.");
      raw.autoTradeBudget = v;
    }
    if (body.dailyLossLimit != null) {
      const v = Number(body.dailyLossLimit);
      if (!Number.isFinite(v) || v < 10000) throw new Error("하루 손실 한도는 1만원 이상이어야 합니다.");
      raw.dailyLossLimit = v;
    }
    if (body.maxDailyOrders != null) {
      const v = Number(body.maxDailyOrders);
      if (!Number.isInteger(v) || v < 1 || v > 100) throw new Error("하루 최대 주문 수는 1~100 사이여야 합니다.");
      raw.maxDailyOrders = v;
    }
    // 실전 자동매매는 주문 허용 없이는 켤 수 없다
    if (raw.allowRealAutoTrade && !raw.allowRealOrders) {
      throw new Error("'실전 주문 허용'을 먼저 켜야 실전 자동매매를 허용할 수 있습니다.");
    }
    writeRawConfig(raw);
    return {
      allowRealOrders: raw.allowRealOrders === true,
      allowRealAutoTrade: raw.allowRealAutoTrade === true,
      maxOrderAmount: raw.maxOrderAmount,
      autoTradeBudget: raw.autoTradeBudget,
      dailyLossLimit: raw.dailyLossLimit,
      maxDailyOrders: raw.maxDailyOrders,
    };
  }

  if (pathname === "/api/search") {
    const { searchStocks } = await import("./stockmaster.js");
    return { results: await searchStocks(q.get("q") ?? "") };
  }

  if (pathname === "/api/watchlist") {
    const file = path.join(projectRoot(), "data", "watchlist.json");
    const load = () => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { favorites: [], recent: [] }; }
    };
    if (req.method === "POST") {
      const w = load();
      const c = String(body.code ?? "").trim();
      const name = String(body.name ?? "").trim();
      if (!/^\d{6}$/.test(c)) throw new Error("종목코드는 숫자 6자리여야 합니다.");
      if (body.action === "favorite") {
        const i = w.favorites.findIndex((f) => f.code === c);
        if (i >= 0) w.favorites.splice(i, 1);
        else w.favorites.unshift({ code: c, name });
      } else {
        w.recent = [{ code: c, name }, ...w.recent.filter((r) => r.code !== c)].slice(0, 8);
        const f = w.favorites.find((f) => f.code === c);
        if (f && name) f.name = name; // 이름을 새로 알게 되면 관심종목에도 반영
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(w, null, 2));
    }
    return load();
  }

  if (pathname === "/api/name") {
    // 상품기본조회로 종목명 시도 — 모의투자에서 미지원일 수 있으므로 실패해도 빈 값으로 응답
    try {
      const { kisRequest } = await import("./kisClient.js");
      const data = await kisRequest({
        path: "/uapi/domestic-stock/v1/quotations/search-info",
        trId: "CTPF1604R",
        params: { PDNO: code, PRDT_TYPE_CD: "300" },
      });
      const name = data.output?.prdt_abrv_name ?? data.output?.prdt_name ?? "";
      if (name) return { name };
    } catch {}
    // 보조: 종목 마스터 목록에서 찾기
    try {
      const { searchStocks } = await import("./stockmaster.js");
      const hit = (await searchStocks(code)).find((s) => s.code === code);
      return { name: hit?.name ?? "" };
    } catch {
      return { name: "" };
    }
  }

  if (pathname === "/api/price") {
    const { getPrice } = await import("./api/quotations.js");
    return await getPrice(code);
  }

  if (pathname === "/api/balance") {
    const { getBalance } = await import("./api/balance.js");
    return await getBalance();
  }

  if (pathname === "/api/collect" && req.method === "POST") {
    const { collectDaily } = await import("./collect.js");
    return await collectDaily(code, "20200101");
  }

  if (pathname === "/api/chart") {
    const { loadDaily } = await import("./store.js");
    const days = Number(q.get("days") ?? 130);
    return { candles: loadDaily(code).slice(-days) };
  }

  if (pathname === "/api/strategies") {
    const { STRATEGIES } = await import("./strategies.js");
    return Object.entries(STRATEGIES).map(([id, st]) => ({
      id,
      name: st.name,
      options: st.grid.map((p) => ({ label: st.label(p), params: p })),
    }));
  }

  if (pathname === "/api/backtest") {
    const { loadDaily } = await import("./store.js");
    const { STRATEGIES, buyHold } = await import("./strategies.js");
    const candles = loadDaily(code);
    if (candles.length < 150) throw new Error("데이터가 부족합니다. 먼저 [데이터 수집]을 눌러주세요.");
    const id = q.get("strategy") ?? "sma";
    const st = STRATEGIES[id];
    if (!st) throw new Error("알 수 없는 전략입니다.");
    let params = null;
    try {
      if (q.get("params")) params = JSON.parse(q.get("params"));
    } catch {}
    if (!params) {
      params = id === "sma"
        ? { short: Number(q.get("short") ?? 5), long: Number(q.get("long") ?? 20) }
        : st.grid[0];
    }
    const r = st.backtest(candles, params);
    return {
      ...r,
      label: st.label(params),
      buyHoldReturn: buyHold(candles).totalReturn,
      period: `${candles[0].date} ~ ${candles[candles.length - 1].date}`,
      initialCash: 10_000_000,
    };
  }

  if (pathname === "/api/order" && req.method === "POST") {
    const { buy, sell } = await import("./api/orders.js");
    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty < 1) throw new Error("수량은 1 이상의 정수로 입력해주세요.");
    const fn = body.side === "sell" ? sell : buy;
    return await fn(code, qty);
  }

  if (pathname === "/api/engine/start" && req.method === "POST") {
    await startEngineBg(code, body.live === true, body.strategy);
    return { ok: true };
  }

  if (pathname === "/api/recommend") {
    const { loadDaily } = await import("./store.js");
    const { recommend } = await import("./strategies.js");
    return recommend(loadDaily(code));
  }

  if (pathname === "/api/engine/stop" && req.method === "POST") {
    if (body.code) {
      engines.get(body.code)?.stop?.();
    } else {
      for (const e of engines.values()) e.stop?.();
    }
    return { ok: true };
  }

  if (pathname === "/api/engine") return engineStatus();

  if (pathname === "/api/mobile") {
    if (req.method === "POST") {
      const raw = readRawConfig();
      if (!raw) throw new Error("설정이 없습니다.");
      if (body.enabled === true) {
        raw.mobile = { enabled: true, pin: raw.mobile?.pin ?? String(crypto.randomInt(100000, 1000000)) };
      } else {
        raw.mobile = { ...(raw.mobile ?? {}), enabled: false };
      }
      writeRawConfig(raw);
    }
    const mc = mobileConfig();
    return {
      enabled: mc.enabled,
      pin: mc.enabled ? mc.pin : null,
      urls: mc.enabled ? lanAddresses().map((ip) => `http://${ip}:${PORT}`) : [],
      listeningLan: SERVER_HOST === "0.0.0.0",
    };
  }

  if (pathname === "/api/update") {
    const { checkForUpdate } = await import("./update.js");
    return { current: appVersion(), remote: await checkForUpdate() };
  }

  if (pathname === "/api/update/apply" && req.method === "POST") {
    const { applyUpdate } = await import("./update.js");
    return { updated: await applyUpdate() };
  }

  throw Object.assign(new Error("없는 API입니다"), { status: 404 });
}

// ── 서버 ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 1e6) req.destroy();
  });
  req.on("end", async () => {
    if (!(await checkMobileAuth(req, res, raw))) return;

    if (pathname.startsWith("/api/")) {
      let body = {};
      try {
        if (raw) body = JSON.parse(raw);
      } catch {}
      try {
        const out = await handleApi(req, res, pathname, body);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(err.status ?? 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 정적 파일 (ui/)
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.join(UI_DIR, rel);
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end("Not Found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
});

const URL_STR = `http://127.0.0.1:${PORT}`;

// 프로그램이 켜져 있는 동안 Windows가 절전 모드로 들어가지 않게 막는다.
// (화면은 평소처럼 꺼지고, 시스템만 깨어 있음. 프로그램 종료 시 원래대로)
function keepAwake() {
  if (process.platform !== "win32") return;
  const script = [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';",
    "$p = Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru;",
    "while ($true) {",
    `  if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { exit }`,
    '  [void]$p::SetThreadExecutionState([uint32]"0x80000001");', // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    "  Start-Sleep -Seconds 50",
    "}",
  ].join(" ");
  try {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: "ignore",
    });
    child.unref();
    process.on("exit", () => {
      try { child.kill(); } catch {}
    });
    console.log("💤 절전 방지 켜짐 — 프로그램이 켜져 있는 동안 컴퓨터가 잠들지 않습니다 (화면은 꺼져도 OK)");
  } catch {}
}

function openBrowser() {
  if (process.env.NO_OPEN === "1") return;
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", URL_STR]]
        : process.platform === "darwin"
          ? ["open", [URL_STR]]
          : ["xdg-open", [URL_STR]];
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("이미 실행 중인 것 같습니다. 브라우저 창을 엽니다.");
    openBrowser();
    process.exit(0);
  }
  throw err;
});

const SERVER_HOST = mobileConfig().enabled ? "0.0.0.0" : "127.0.0.1";

server.listen(PORT, SERVER_HOST, () => {
  console.log(`주식 매매 프로그램이 켜졌습니다: ${URL_STR}`);
  console.log("이 검은 창은 프로그램의 엔진입니다. 닫으면 프로그램도 꺼져요. (최소화는 OK)");
  if (SERVER_HOST === "0.0.0.0") {
    const mc = mobileConfig();
    for (const ip of lanAddresses()) console.log(`📱 핸드폰(같은 와이파이): http://${ip}:${PORT}  (PIN ${mc.pin})`);
  }
  keepAwake();
  openBrowser();
});
