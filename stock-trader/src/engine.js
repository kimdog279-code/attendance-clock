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

// 엔진 상태는 모의/실전 그리고 연습/자동주문을 전부 분리한다.
// 연습 모드의 "샀다 치고" 기억이 자동주문 모드에 넘어가도 안 되고,
// 모의의 기억이 실전에 넘어가도 안 되기 때문.
function statePath(code, live) {
  const config = loadConfig();
  return path.join(config.root, "data", `engine-${code}-${config.mode}-${live ? "live" : "practice"}.json`);
}

function loadState(code, live) {
  try {
    return JSON.parse(fs.readFileSync(statePath(code, live), "utf8"));
  } catch {}
  // 구버전 파일 이전: 연습/자동주문 구분이 없던 기록은 안전한 쪽(연습)으로 보관
  try {
    const config = loadConfig();
    const dataDir = path.join(config.root, "data");
    for (const [oldName, mode] of [
      [`engine-${code}-${config.mode}.json`, config.mode],
      [`engine-${code}.json`, "paper"],
    ]) {
      const oldPath = path.join(dataDir, oldName);
      if (!fs.existsSync(oldPath)) continue;
      const dest = path.join(dataDir, `engine-${code}-${mode}-practice.json`);
      if (!fs.existsSync(dest)) fs.renameSync(oldPath, dest);
      else fs.rmSync(oldPath);
    }
    if (!live) return JSON.parse(fs.readFileSync(statePath(code, false), "utf8"));
  } catch {}
  return { position: null, lastSignal: null };
}

function saveState(code, state, live) {
  fs.mkdirSync(path.dirname(statePath(code, live)), { recursive: true });
  fs.writeFileSync(statePath(code, live), JSON.stringify(state, null, 2));
}

function logLine(text) {
  const config = loadConfig();
  const file = path.join(config.root, "data", "auto-trade.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tag = config.mode === "real" ? "실전" : "모의";
  fs.appendFileSync(file, `[${kst().dateStr} ${kst().timeStr}][${tag}] ${text}\n`);
}

// live=true면 모의투자 주문까지 실행, false면 신호만.
// strategy: { id, params } — 생략 시 이동평균 5/20.
// stopPromise가 resolve되면 다음 사이클에서 멈춘다.
export async function startEngine({ code, live, stopPromise, strategy, log = console.log }) {
  const config = loadConfig();
  const pollMs = Number(process.env.ENGINE_POLL_MS ?? 30000);
  const { STRATEGIES } = await import("./strategies.js");
  const stratId = strategy?.id && STRATEGIES[strategy.id] ? strategy.id : "sma";
  const stratParams = strategy?.params ?? { short: 5, long: 20 };
  const strat = STRATEGIES[stratId];

  const realLive = live && config.mode === "real";
  if (realLive && (!config.allowRealOrders || !config.allowRealAutoTrade)) {
    log(
      "⚠ 실전 자동 주문이 잠겨 있습니다. [⚠ 실전 안전장치]에서 " +
        "'실전 주문 허용'과 '실전 자동매매 허용'을 모두 켜야 합니다. 연습 모드로 전환합니다."
    );
    live = false;
  }
  // 실전 자동매매의 매수 1회 예산: 자동매매 예산과 1건 상한 중 작은 쪽
  const buyBudget =
    config.mode === "real" && config.maxOrderAmount > 0
      ? Math.min(config.autoTradeBudget, config.maxOrderAmount)
      : config.autoTradeBudget;

  const stopLossPct = Math.max(0, Number(config.stopLossPercent ?? 0));

  let lastErrorMessage = null;
  let sameErrorCount = 0;
  let lastBlockNotice = null;

  let stopped = false;
  stopPromise.then(() => {
    stopped = true;
  });

  // 매도 실행 (전략 신호·손절 공용). reason은 로그에 남는 사유, isStop은 손절 여부.
  // 호출부에서 state.position이 있는 것을 보장한다.
  let currentPrice = 0;
  const doSell = async (reason, isStop) => {
    const entry = state.position.entryPrice;
    const pct = (((currentPrice - entry) / entry) * 100).toFixed(2);
    const tag = isStop ? "🛑 손절" : "🔴 매도";
    if (live) {
      const { getBalance } = await import("./api/balance.js");
      const { sell } = await import("./api/orders.js");
      const holding = (await getBalance()).holdings.find((h) => h.code === code);
      if (!holding) {
        log(`${tag} 신호! 하지만 계좌에 이 종목이 없어 건너뜁니다.`);
        state.position = null;
        return;
      }
      const r = await sell(code, holding.qty);
      if (config.mode === "real") {
        state.dayStats.orders++;
        // 실현 손익 추정치를 하루 한도 계산에 반영 (수수료·거래세 근사 포함)
        const qty = Math.min(holding.qty, state.position.qty || holding.qty);
        state.dayStats.pnl += (currentPrice * (1 - 0.00165) - entry * (1 + 0.00015)) * qty;
      }
      log(`${tag} 주문 실행! ${holding.qty}주 @ ${won(currentPrice)}원 (${pct}%, ${reason}) — 주문번호 ${r.orderNo}`);
      logLine(
        `${isStop ? "손절" : "매도"} 주문 ${code} ${holding.qty}주 @ ${currentPrice} ` +
          `[매수 ${entry} · ${pct}% · ${strat.name} · ${reason}]`
      );
    } else {
      log(`🔔 [연습] ${isStop ? "손절" : "매도"} (${reason})! ${won(entry)}원에 샀다면 지금 ${won(currentPrice)}원 (${pct}%)에 팔았을 거예요.`);
      logLine(`[연습] ${isStop ? "손절" : "매도"} 신호 ${code} @ ${currentPrice} [${pct}% · ${strat.name}]`);
    }
    state.position = null;
  };

  // 최근 일봉 최신화 (약 넉 달치면 20일 이동평균 계산에 충분)
  log("최근 일봉 데이터를 최신화하는 중...");
  const fourMonthsAgo = new Date(Date.now() - 120 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10).replaceAll("-", "");
  await collectDaily(code, fourMonthsAgo);

  const { getPrice } = await import("./api/quotations.js");
  const state = loadState(code, live);

  // 자동주문 모드: 기록보다 실제 계좌가 진실 — 시작할 때 대조해서 안 맞으면 기록을 버린다
  if (live && state.position) {
    try {
      const { getBalance } = await import("./api/balance.js");
      const holding = (await getBalance()).holdings.find((h) => h.code === code);
      if (!holding) {
        log("이전 기록에는 보유 중이지만 계좌에는 이 종목이 없어 기록을 초기화합니다.");
        state.position = null;
        saveState(code, state, live);
      } else if (state.position.qty > holding.qty) {
        log(`기록(${won(state.position.qty)}주)보다 계좌 보유(${won(holding.qty)}주)가 적어 계좌 기준으로 맞춥니다.`);
        state.position.qty = holding.qty;
        saveState(code, state, live);
      }
    } catch (err) {
      log(`계좌 대조 실패 (기존 기록대로 진행): ${err.message}`);
    }
  }

  log(
    `\n자동매매 시작 — ${code}, ${
      live ? (config.mode === "real" ? "🚨 실전 주문 실행 모드 (진짜 돈!)" : "🟢 모의주문 실행 모드") : "🔵 연습 모드(신호만)"
    }`
  );
  log(`전략: ${strat.label(stratParams)}, ${pollMs / 1000}초마다 확인`);
  if (live && config.mode === "real") {
    log(
      `안전장치: 하루 손실 한도 ${won(config.dailyLossLimit)}원 · 하루 최대 ${config.maxDailyOrders}회 주문 · 매수 1회 ${won(buyBudget)}원`
    );
  }
  log(`손절선: ${stopLossPct > 0 ? `매수가 대비 -${stopLossPct}% (전략과 무관하게 즉시 매도)` : "사용 안 함"}`);
  // 예산이 계좌 현금보다 크면 매수 때마다 예산이 잘려서 헷갈린다 — 시작할 때 미리 알려준다
  if (live) {
    try {
      const { getBuyableCash, getBalance } = await import("./api/balance.js");
      const b = await getBuyableCash(code, null);
      const cashNow = b ? b.amount : (await getBalance()).cash;
      if (cashNow > 0 && buyBudget > cashNow) {
        const suggest = Math.max(10000, Math.floor((cashNow * 0.9) / 10000) * 10000);
        log(
          `⚠ 매수 1회 예산(${won(buyBudget)}원)이 지금 살 수 있는 돈(${won(Math.floor(cashNow))}원)보다 큽니다. ` +
            `실제로는 현금 범위 안에서만 주문하니 거부되지는 않지만, ` +
            `[매수 1회 예산]을 ${won(suggest)}원 이하로 낮춰두면 계산이 명확해집니다.`
        );
      }
    } catch {
      // 조회 실패는 넘어간다 — 매수 시점에 다시 확인한다
    }
  }
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

      // 실전 자동매매 일일 안전장치
      if (live && config.mode === "real") {
        if (state.dayStats?.date !== today) {
          state.dayStats = { date: today, orders: 0, pnl: 0 };
          saveState(code, state, live);
        }
        if (config.dailyLossLimit > 0 && state.dayStats.pnl <= -config.dailyLossLimit) {
          log(
            `🛑 오늘 실현 손실 ${won(Math.round(-state.dayStats.pnl))}원이 하루 한도(${won(config.dailyLossLimit)}원)에 도달해 자동매매를 멈춥니다.` +
              (state.position ? " 보유 포지션은 그대로 남아 있으니 직접 확인하세요." : "")
          );
          logLine(`하루 손실 한도 도달로 정지 (${Math.round(state.dayStats.pnl)}원)`);
          break;
        }
      }

      const history = loadDaily(code).filter((c) => c.date < today);
      const p = await getPrice(code);
      currentPrice = p.price;
      lastErrorMessage = null; // 시세 조회가 성공했으면 오류 상태 해제
      const quote = { price: p.price, open: p.open, today };
      const { signal, note } = strat.signalNow(history, quote, state.position, stratParams);

      if (note === "데이터 부족") {
        log("일봉 데이터가 부족합니다. [데이터 수집]을 먼저 실행해주세요.");
        break;
      }

      const posLabel = state.position
        ? state.position.qty > 0
          ? `보유 ${won(state.position.qty)}주`
          : "보유 중(연습)"
        : "미보유";
      log(`[${kst().timeStr}] 현재가 ${won(p.price)} | ${note} | ${posLabel}`);

      // ── 손절 검사: 전략 신호보다 먼저, 무조건 우선 ──────────────
      // 손실이 커지기 전에 끊는다. 손절한 날은 같은 종목을 다시 사지 않는다.
      if (state.position && stopLossPct > 0) {
        const entry = state.position.entryPrice;
        const dropPct = ((p.price - entry) / entry) * 100;
        if (dropPct <= -stopLossPct) {
          await doSell(`손절 ${dropPct.toFixed(2)}%`, true);
          state.stoppedOut = { date: today };
          saveState(code, state, live);
          await Promise.race([sleep(pollMs), stopPromise]);
          continue;
        }
      }

      // 손절한 날은 하루 종일 재매수 금지. 현금 부족은 30분 뒤 다시 시도.
      const stoppedOutToday = state.stoppedOut?.date === today;
      const cashBlocked = state.cashShortUntil != null && Date.now() < state.cashShortUntil;
      const alreadyFired = state.lastSignal?.date === today && state.lastSignal?.type === signal;

      // 신호가 왔는데 실행하지 않을 때는 이유를 반드시 알린다 (같은 사유는 한 번만)
      if (signal === "buy" && !state.position) {
        let block = null;
        if (alreadyFired) block = "오늘 이미 매수가 한 번 실행됐습니다 (하루 1회 제한)";
        else if (stoppedOutToday) block = "오늘 손절한 종목이라 재매수하지 않습니다";
        else if (cashBlocked) {
          const mins = Math.ceil((state.cashShortUntil - Date.now()) / 60000);
          block = `현금이 부족해 대기 중입니다 (약 ${mins}분 뒤 다시 확인)`;
        }
        if (block && lastBlockNotice !== block) {
          lastBlockNotice = block;
          log(`⏸ 매수 신호가 왔지만 건너뜁니다 — ${block}`);
        }
      }

      // 주문이 실패하면 lastSignal을 남기지 않는다 — 안 샀는데 '오늘 샀음'으로
      // 기록되면 그날 내내 매수 기회를 놓치기 때문
      if (signal === "buy" && !state.position && !alreadyFired && !stoppedOutToday && !cashBlocked) {
        if (live) {
          const { buy } = await import("./api/orders.js");
          const { getBalance, getBuyableCash } = await import("./api/balance.js");
          // 예산만 보고 주문하면 현금이 모자랄 때 '주문가능금액 초과'로 계속 거부된다.
          // 증권사의 매수가능금액을 먼저 묻고, 실패하면 잔고 예수금으로 대체한다.
          let cash = Infinity;
          const buyable = await getBuyableCash(code, null);
          if (buyable) {
            cash = buyable.amount;
          } else {
            try {
              cash = (await getBalance()).cash;
            } catch (err) {
              log(`가용 현금 확인 실패, 예산 기준으로 진행합니다: ${err.message}`);
            }
          }
          // 수수료·호가 변동 여유로 0.5% 남긴다
          const spendable = Math.min(buyBudget, cash === Infinity ? buyBudget : cash * 0.995);
          let qty = Math.floor(spendable / p.price);
          // 증권사가 직접 알려준 최대 매수가능수량이 있으면 그 이상은 절대 주문하지 않는다
          if (buyable?.qty > 0) qty = Math.min(qty, buyable.qty);
          if (config.mode === "real" && state.dayStats.orders >= config.maxDailyOrders) {
            log(`⏸ 매수 신호가 왔지만 오늘 주문 한도(${config.maxDailyOrders}회)에 도달해 신규 매수를 건너뜁니다.`);
          } else if (qty < 1) {
            log(
              `🔔 매수 신호! 하지만 살 수 있는 돈이 부족해 건너뜁니다 ` +
                `(예산 ${won(buyBudget)}원 · 가용 현금 ${cash === Infinity ? "확인 불가" : won(Math.floor(cash)) + "원"} · 주가 ${won(p.price)}원). ` +
                `30분 뒤에 다시 확인합니다.`
            );
            state.cashShortUntil = Date.now() + 30 * 60 * 1000; // 30분 뒤 재확인
            saveState(code, state, live);
          } else {
            const r = await buy(code, qty);
            state.position = { qty, entryPrice: p.price, date: today };
            state.lastSignal = { date: today, type: "buy" };
            state.cashShortUntil = null;
            if (config.mode === "real") state.dayStats.orders++;
            const short = spendable < buyBudget - p.price;
            log(
              `🟢 매수 주문 실행! ${qty}주 (약 ${won(qty * p.price)}원, 주문번호 ${r.orderNo})` +
                (short ? ` — 현금이 부족해 예산(${won(buyBudget)}원)보다 적게 샀습니다` : "")
            );
            logLine(`매수 주문 ${code} ${qty}주 @ ${p.price} [${strat.name}]`);
          }
        } else {
          state.position = { qty: 0, entryPrice: p.price, date: today };
          state.lastSignal = { date: today, type: "buy" };
          log(`🔔 [연습] 매수 신호 (${note})! 지금이라면 ${won(p.price)}원에 매수했을 거예요.`);
          logLine(`[연습] 매수 신호 ${code} @ ${p.price} [${strat.name}]`);
        }
        saveState(code, state, live);
      } else if (signal === "sell" && state.position && !alreadyFired) {
        state.lastSignal = { date: today, type: "sell" };
        await doSell(note, false);
        saveState(code, state, live);
      }
    } catch (err) {
      // 같은 오류가 30초마다 반복되면 화면이 도배된다 — 처음과 그 뒤 10회마다만 알린다
      if (err.message === lastErrorMessage) {
        sameErrorCount++;
        if (sameErrorCount % 10 === 0) {
          log(`(같은 오류가 ${sameErrorCount + 1}번째 반복 중입니다: ${err.message})`);
        }
      } else {
        lastErrorMessage = err.message;
        sameErrorCount = 0;
        log(`오류 (계속 재시도합니다): ${err.message}`);
        logLine(`오류: ${err.message}`);
      }
    }

    await Promise.race([sleep(pollMs), stopPromise]);
  }

  log("\n자동매매를 멈췄습니다. (기록: data/auto-trade.log)");
  logLine("엔진 정지");
}
