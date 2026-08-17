// 로컬 웹 대시보드 서버.
// 시작하기.bat이 이 파일을 실행하면 브라우저가 자동으로 열린다.
// 127.0.0.1(내 컴퓨터)에서만 접속 가능 — 외부에서는 접근할 수 없다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { configExists, loadConfig, configPath, resetConfigCache, projectRoot } from "./config.js";
import { startEngine } from "./engine.js";

const PORT = 8321;
const UI_DIR = path.join(projectRoot(), "ui");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
}

// ── 자동매매 엔진 관리 (서버당 1개) ─────────────────────────────
const engine = { running: false, code: null, live: false, logs: [], stop: null, strategyLabel: null };

function engineLog(msg) {
  for (const line of String(msg).split("\n")) {
    if (line.trim() === "") continue;
    engine.logs.push(line);
  }
  if (engine.logs.length > 300) engine.logs.splice(0, engine.logs.length - 300);
  console.log(msg);
}

async function startEngineBg(code, live, strategy) {
  if (engine.running) throw new Error("자동매매가 이미 실행 중입니다. 먼저 정지해주세요.");
  const { STRATEGIES } = await import("./strategies.js");
  const id = strategy?.id && STRATEGIES[strategy.id] ? strategy.id : "sma";
  const params = strategy?.params ?? { short: 5, long: 20 };
  let stopResolver;
  const stopPromise = new Promise((resolve) => (stopResolver = resolve));
  Object.assign(engine, {
    running: true, code, live, logs: [], stop: stopResolver,
    strategyLabel: STRATEGIES[id].label(params),
  });
  startEngine({ code, live, stopPromise, strategy: { id, params }, log: engineLog })
    .catch((err) => engineLog(`엔진 오류로 중단: ${err.message}`))
    .finally(() => {
      engine.running = false;
    });
}

function engineStatus() {
  let position = null;
  if (engine.code) {
    try {
      position = JSON.parse(
        fs.readFileSync(path.join(projectRoot(), "data", `engine-${engine.code}.json`), "utf8")
      ).position;
    } catch {}
  }
  return { running: engine.running, code: engine.code, live: engine.live, strategyLabel: engine.strategyLabel, logs: engine.logs.slice(-40), position };
}

// ── API 핸들러 ─────────────────────────────────────────────────
async function handleApi(req, res, pathname, body) {
  const q = new URL(req.url, "http://x").searchParams;
  const code = (q.get("code") ?? body?.code ?? "005930").trim();

  if (pathname === "/api/status") {
    const out = { version: appVersion(), configured: configExists(), mode: null, engine: engineStatus() };
    if (out.configured) {
      try { out.mode = loadConfig().mode; } catch { out.configured = false; }
    }
    return out;
  }

  if (pathname === "/api/setup" && req.method === "POST") {
    let accountNo = String(body.accountNo ?? "").trim().replaceAll(" ", "");
    if (/^\d{8}$/.test(accountNo)) accountNo += "-01";
    if (!/^\d{8}-\d{2}$/.test(accountNo)) throw new Error("계좌번호는 숫자 8자리로 입력해주세요.");
    const appKey = String(body.appKey ?? "").trim();
    const appSecret = String(body.appSecret ?? "").trim();
    if (!appKey || appSecret.length < 20) throw new Error("APP Key 또는 APP Secret이 비어 있거나 너무 짧습니다.");
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ mode: "paper", appKey, appSecret, accountNo, allowRealOrders: false, maxOrderAmount: 100000, autoTradeBudget: 1000000 }, null, 2)
    );
    resetConfigCache();
    const { getPrice } = await import("./api/quotations.js");
    const p = await getPrice("005930");
    return { ok: true, samplePrice: p.price };
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
    if (engine.stop) engine.stop();
    return { ok: true };
  }

  if (pathname === "/api/engine") return engineStatus();

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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`주식 매매 프로그램이 켜졌습니다: ${URL_STR}`);
  console.log("이 검은 창은 프로그램의 엔진입니다. 닫으면 프로그램도 꺼져요. (최소화는 OK)");
  openBrowser();
});
