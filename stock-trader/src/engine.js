// 자동매매 엔진.
// 30초마다 현재가를 확인해서 이동평균 골든/데드크로스 신호를 감지한다.
//  - 연습 모드(기본): 신호만 화면·로그에 기록, 주문 없음
//  - 주문 모드: 모의투자 계좌에 실제로 매수/매도 주문 (실전 모드에서는 강제로 연습만)
// 신호는 하루에 같은 방향으로 한 번만 발동한다 (data/engine-<종목>.json에 기록).
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadDaily } from "./store.js";
import { collectDaily } from "./collect.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const won = (n) => Number(n).toLocaleString("ko-KR");

// KST(한국시간) 기준 현재 시각 — KST는 서머타임이 없어 고정 +9시간
function kst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    dateStr: d.toISOString().slice(0, 10).replaceAll("-", ""),
    timeStr: d.toISOString().slice(11, 16),
    day: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

export function marketOpenNow() {
  if (process.env.ENGINE_IGNORE_HOURS === "1") return true;
  const { day, minutes } = kst();
  if (day === 0 || day === 6) return false; // 주말
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30; // 09:00 ~ 15:30
}

// 순수 신호 판정 로직 (테스트 가능하도록 분리)
// candles: 오늘 이전까지의 일봉(날짜 오름차순), currentPrice: 지금 가격
export function evaluateSignal(candles, currentPrice, { shortPeriod = 5, longPeriod = 20 } = {}) {
  const closes = candles.map((c) => c.close);
  if (closes.length < longPeriod + 1) return { signal: null, reason: "insufficient-data" };

  const series = [...closes, currentPrice];
  const sma = (n, i) => {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += series[j];
    return sum / n;
  };

  const i = series.length - 1;
  const shortNow = sma(shortPeriod, i);
  const longNow = sma(longPeriod, i);
  const shortPrev = sma(shortPeriod, i - 1);
  const longPrev = sma(longPeriod, i - 1);

  let signal = null;
  if (shortPrev <= longPrev && shortNow > longNow) signal = "buy";
  else if (shortPrev >= longPrev && shortNow < longNow) signal = "sell";

  return { signal, shortNow, longNow };
}

function statePath(code) {
  return path.join(loadConfig().root, "data", `engine-${code}.json`);
}

function loadState(code) {
  try {
    return JSON.parse(fs.readFileSync(statePath(code), "utf8"));
  } catch {
    return { position: null, lastSignal: null };
  }
}

function saveState(code, state) {
  fs.mkdirSync(path.dirname(statePath(code)), { recursive: true });
  fs.writeFileSync(statePath(code), JSON.stringify(state, null, 2));
}

function logLine(text) {
  const file = path.join(loadConfig().root, "data", "auto-trade.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `[${kst().dateStr} ${kst().timeStr}] ${text}\n`);
}

// live=true면 모의투자 주문까지 실행, false면 신호만.
// stopPromise가 resolve되면 다음 사이클에서 멈춘다.
export async function startEngine({ code, live, stopPromise, log = console.log }) {
  const config = loadConfig();
  const pollMs = Number(process.env.ENGINE_POLL_MS ?? 30000);

  if (live && config.mode === "real") {
    log("⚠ 실전투자 모드에서는 자동 주문을 지원하지 않습니다. 연습 모드로 전환합니다.");
    live = false;
  }

  let stopped = false;
  stopPromise.then(() => {
    stopped = true;
  });

  // 최근 일봉 최신화 (약 넉 달치면 20일 이동평균 계산에 충분)
  log("최근 일봉 데이터를 최신화하는 중...");
  const fourMonthsAgo = new Date(Date.now() - 120 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10).replaceAll("-", "");
  await collectDaily(code, fourMonthsAgo);

  const { getPrice } = await import("./api/quotations.js");
  const state = loadState(code);

  log(`\n자동매매 시작 — ${code}, ${live ? "🟢 모의주문 실행 모드" : "🔵 연습 모드(신호만)"}`);
  log(`전략: 5일/20일 이동평균 크로스, ${pollMs / 1000}초마다 확인`);
  log(`보유 상태: ${state.position ? `${won(state.position.qty)}주 보유 중` : "없음"}`);
  logLine(`엔진 시작 ${code} (${live ? "주문 실행" : "연습"})`);

  while (!stopped) {
    try {
      if (!marketOpenNow()) {
        log(`[${kst().timeStr}] 장이 닫혀 있습니다 (평일 09:00~15:30에만 동작). 대기 중...`);
        await Promise.race([sleep(60000), stopPromise]);
        continue;
      }

      const today = kst().dateStr;
      const history = loadDaily(code).filter((c) => c.date < today);
      const p = await getPrice(code);
      const { signal, shortNow, longNow, reason } = evaluateSignal(history, p.price);

      if (reason === "insufficient-data") {
        log("일봉 데이터가 부족합니다. 메뉴 3(데이터 수집)을 먼저 실행해주세요.");
        break;
      }

      const posLabel = state.position
        ? state.position.qty > 0
          ? `보유 ${won(state.position.qty)}주`
          : "보유 중(연습)"
        : "미보유";
      log(
        `[${kst().timeStr}] 현재가 ${won(p.price)} | 5일선 ${won(Math.round(shortNow))} / 20일선 ${won(Math.round(longNow))} | ${posLabel}`
      );

      const alreadyFired = state.lastSignal?.date === today && state.lastSignal?.type === signal;

      if (signal === "buy" && !state.position && !alreadyFired) {
        state.lastSignal = { date: today, type: "buy" };
        if (live) {
          const { buy } = await import("./api/orders.js");
          const qty = Math.floor(config.autoTradeBudget / p.price);
          if (qty < 1) {
            log(`🔔 매수 신호! 하지만 예산(${won(config.autoTradeBudget)}원)으로 1주도 살 수 없어 건너뜁니다.`);
          } else {
            const r = await buy(code, qty);
            state.position = { qty, entryPrice: p.price, date: today };
            log(`🟢 매수 주문 실행! ${qty}주 (주문번호 ${r.orderNo})`);
            logLine(`매수 주문 ${code} ${qty}주 @ ${p.price}`);
          }
        } else {
          state.position = { qty: 0, entryPrice: p.price, date: today };
          log(`🔔 [연습] 골든크로스 매수 신호! 지금이라면 ${won(p.price)}원에 매수했을 거예요.`);
          logLine(`[연습] 매수 신호 ${code} @ ${p.price}`);
        }
        saveState(code, state);
      } else if (signal === "sell" && state.position && !alreadyFired) {
        state.lastSignal = { date: today, type: "sell" };
        if (live) {
          const { getBalance } = await import("./api/balance.js");
          const { sell } = await import("./api/orders.js");
          const holding = (await getBalance()).holdings.find((h) => h.code === code);
          if (!holding) {
            log("🔔 매도 신호! 하지만 계좌에 이 종목이 없어 건너뜁니다.");
          } else {
            const r = await sell(code, holding.qty);
            log(`🔴 매도 주문 실행! ${holding.qty}주 (주문번호 ${r.orderNo})`);
            logLine(`매도 주문 ${code} ${holding.qty}주 @ ${p.price}`);
          }
        } else {
          const entry = state.position.entryPrice;
          const pct = (((p.price - entry) / entry) * 100).toFixed(2);
          log(`🔔 [연습] 데드크로스 매도 신호! ${won(entry)}원에 샀다면 지금 ${won(p.price)}원 (${pct}%)에 팔았을 거예요.`);
          logLine(`[연습] 매도 신호 ${code} @ ${p.price}`);
        }
        state.position = null;
        saveState(code, state);
      }
    } catch (err) {
      log(`오류 (계속 재시도합니다): ${err.message}`);
      logLine(`오류: ${err.message}`);
    }

    await Promise.race([sleep(pollMs), stopPromise]);
  }

  log("\n자동매매를 멈췄습니다. (기록: data/auto-trade.log)");
  logLine("엔진 정지");
}
