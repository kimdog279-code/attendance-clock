// 전략 모음 + 전략 추천.
// 모든 전략은 두 가지 얼굴을 가진다:
//  - backtest(candles, params): 과거 데이터 성적표 (다음 날 시가 체결, 수수료·거래세 반영)
//  - signalNow(history, quote, position, params): 자동매매 엔진용 실시간 판정
const FEE = 0.00015; // 수수료 0.015%
const TAX = 0.0015; // 거래세 0.15% (매도)
const CASH = 10_000_000;

const sma = (arr, n, i) => {
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += arr[j];
  return s / n;
};

function rsiAt(closes, period, i) {
  let gain = 0, loss = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const d = closes[j] - closes[j - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (gain + loss === 0) return 50;
  return (gain / (gain + loss)) * 100;
}

function bandsAt(closes, period, k, i) {
  const mean = sma(closes, period, i);
  let v = 0;
  for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mean) ** 2;
  const sd = Math.sqrt(v / period);
  return { lower: mean - k * sd, mean, upper: mean + k * sd };
}

// 공통 시뮬레이터: i일 종가 기준 신호 → i+1일 시가 체결, 롱 단일 포지션
function simulate(candles, warmup, signalAt) {
  let cash = CASH, qty = 0, entryCost = 0;
  let peak = CASH, mdd = 0, wins = 0, sells = 0;
  for (let i = warmup; i < candles.length - 1; i++) {
    const want = signalAt(i, qty > 0);
    const px = candles[i + 1].open;
    if (want === "buy" && qty === 0) {
      qty = Math.floor(cash / (px * (1 + FEE)));
      if (qty > 0) {
        entryCost = qty * px * (1 + FEE);
        cash -= entryCost;
      }
    } else if (want === "sell" && qty > 0) {
      const proceeds = qty * px * (1 - FEE - TAX);
      cash += proceeds;
      sells++;
      if (proceeds > entryCost) wins++;
      qty = 0;
    }
    const eq = cash + qty * candles[i + 1].close;
    if (eq > peak) peak = eq;
    mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const finalEquity = cash + qty * candles[candles.length - 1].close;
  return {
    totalReturn: finalEquity / CASH - 1,
    maxDrawdown: mdd,
    tradeCount: sells,
    winRate: sells ? wins / sells : null,
    finalEquity: Math.round(finalEquity),
  };
}

export const STRATEGIES = {
  sma: {
    name: "이동평균 크로스",
    label: (p) => `이동평균 크로스 ${p.short}/${p.long}일`,
    grid: [{ short: 5, long: 20 }, { short: 10, long: 60 }, { short: 20, long: 120 }],
    backtest(candles, p) {
      const c = candles.map((x) => x.close);
      return simulate(candles, p.long, (i) => {
        const sPrev = sma(c, p.short, i - 1), lPrev = sma(c, p.long, i - 1);
        const sNow = sma(c, p.short, i), lNow = sma(c, p.long, i);
        if (sPrev <= lPrev && sNow > lNow) return "buy";
        if (sPrev >= lPrev && sNow < lNow) return "sell";
        return null;
      });
    },
    signalNow(history, quote, position, p) {
      const c = [...history.map((x) => x.close), quote.price];
      const i = c.length - 1;
      if (i < p.long) return { signal: null, note: "데이터 부족" };
      const sPrev = sma(c, p.short, i - 1), lPrev = sma(c, p.long, i - 1);
      const sNow = sma(c, p.short, i), lNow = sma(c, p.long, i);
      let signal = null;
      if (sPrev <= lPrev && sNow > lNow) signal = "buy";
      else if (sPrev >= lPrev && sNow < lNow) signal = "sell";
      return { signal, note: `${p.short}일선 ${Math.round(sNow).toLocaleString("ko-KR")} / ${p.long}일선 ${Math.round(lNow).toLocaleString("ko-KR")}` };
    },
  },

  rsi: {
    name: "RSI 역추세",
    label: (p) => `RSI 역추세 (${p.period}일, ${p.buyBelow} 매수/${p.sellAbove} 매도)`,
    grid: [{ period: 14, buyBelow: 30, sellAbove: 60 }, { period: 14, buyBelow: 25, sellAbove: 55 }],
    backtest(candles, p) {
      const c = candles.map((x) => x.close);
      return simulate(candles, p.period + 1, (i) => {
        const r = rsiAt(c, p.period, i);
        if (r < p.buyBelow) return "buy";
        if (r > p.sellAbove) return "sell";
        return null;
      });
    },
    signalNow(history, quote, position, p) {
      const c = [...history.map((x) => x.close), quote.price];
      const i = c.length - 1;
      if (i < p.period + 1) return { signal: null, note: "데이터 부족" };
      const r = rsiAt(c, p.period, i);
      let signal = null;
      if (r < p.buyBelow) signal = "buy";
      else if (r > p.sellAbove) signal = "sell";
      return { signal, note: `RSI ${r.toFixed(1)}` };
    },
  },

  bb: {
    name: "볼린저밴드",
    label: (p) => `볼린저밴드 (${p.period}일, ${p.k}σ)`,
    grid: [{ period: 20, k: 2 }, { period: 20, k: 1.5 }],
    backtest(candles, p) {
      const c = candles.map((x) => x.close);
      return simulate(candles, p.period, (i) => {
        const b = bandsAt(c, p.period, p.k, i);
        if (c[i] < b.lower) return "buy";
        if (c[i] > b.mean) return "sell";
        return null;
      });
    },
    signalNow(history, quote, position, p) {
      const c = history.map((x) => x.close);
      const i = c.length - 1;
      if (i < p.period) return { signal: null, note: "데이터 부족" };
      const b = bandsAt(c, p.period, p.k, i);
      let signal = null;
      if (quote.price < b.lower) signal = "buy";
      else if (quote.price > b.mean) signal = "sell";
      return { signal, note: `밴드 하단 ${Math.round(b.lower).toLocaleString("ko-KR")} / 중심 ${Math.round(b.mean).toLocaleString("ko-KR")}` };
    },
  },

  vb: {
    name: "변동성 돌파",
    label: (p) => `변동성 돌파 (k=${p.k}, 당일 청산)`,
    grid: [{ k: 0.5 }, { k: 0.3 }],
    // 당일 시가 + k×전일변동폭 돌파 시 매수, 다음 날 시가 청산 — 전용 시뮬레이터
    backtest(candles, p) {
      let equity = CASH, peak = CASH, mdd = 0, wins = 0, trades = 0;
      for (let i = 1; i < candles.length - 1; i++) {
        const target = candles[i].open + p.k * (candles[i - 1].high - candles[i - 1].low);
        if (candles[i].high >= target) {
          const exit = candles[i + 1].open;
          const gross = exit / target;
          const net = gross * (1 - FEE) * (1 - FEE - TAX);
          equity *= net;
          trades++;
          if (net > 1) wins++;
        }
        if (equity > peak) peak = equity;
        mdd = Math.max(mdd, (peak - equity) / peak);
      }
      return {
        totalReturn: equity / CASH - 1,
        maxDrawdown: mdd,
        tradeCount: trades,
        winRate: trades ? wins / trades : null,
        finalEquity: Math.round(equity),
      };
    },
    signalNow(history, quote, position, p) {
      const prev = history[history.length - 1];
      if (!prev) return { signal: null, note: "데이터 부족" };
      const target = quote.open + p.k * (prev.high - prev.low);
      // 어제(또는 그 전) 산 포지션은 새 날 첫 확인 때 청산
      if (position && position.date && position.date < quote.today) {
        return { signal: "sell", note: "당일 청산 규칙" };
      }
      if (!position && quote.price >= target) {
        return { signal: "buy", note: `돌파선 ${Math.round(target).toLocaleString("ko-KR")} 넘음` };
      }
      return { signal: null, note: `돌파선 ${Math.round(target).toLocaleString("ko-KR")}` };
    },
  },
};

// 단순 보유 성적 (비교 기준)
export function buyHold(candles) {
  const start = candles[0].open, end = candles[candles.length - 1].close;
  let peak = 0, mdd = 0;
  for (const c of candles) {
    if (c.close > peak) peak = c.close;
    mdd = Math.max(mdd, (peak - c.close) / peak);
  }
  return { totalReturn: (end * (1 - FEE - TAX)) / (start * (1 + FEE)) - 1, maxDrawdown: mdd, tradeCount: 1, winRate: null };
}

// ── 전략 추천 ──────────────────────────────────────────────────
// 최근 1년(250거래일)을 "시험 기간"으로 숨겨두고, 나머지(연습 기간)로 성적을 매긴 뒤
// 연습 상위 3개를 시험 기간에 다시 돌려 최종 1등을 추천한다. (과최적화 방지 장치)
export function recommend(candles) {
  if (candles.length < 400) {
    throw new Error(`데이터가 부족합니다 (${candles.length}일). [데이터 수집]으로 2020년부터 모아주세요.`);
  }
  const validateDays = Math.min(250, Math.floor(candles.length * 0.4));
  const train = candles.slice(0, -validateDays);
  // 전략별 지표 워밍업만큼만 앞을 붙여, 실제 매매는 정확히 시험 기간부터 시작되게 한다
  const warmupOf = (id, p) =>
    id === "sma" ? p.long : id === "rsi" ? p.period + 1 : id === "bb" ? p.period : 1;
  const validateEval = (id, p) =>
    STRATEGIES[id].backtest(candles.slice(-(validateDays + warmupOf(id, p))), p);

  const score = (r) => r.totalReturn - 0.5 * r.maxDrawdown; // 수익률에서 낙폭의 절반을 벌점으로

  const all = [];
  for (const [id, st] of Object.entries(STRATEGIES)) {
    for (const p of st.grid) {
      const trainR = st.backtest(train, p);
      all.push({ id, params: p, label: st.label(p), train: trainR, trainScore: score(trainR) });
    }
  }
  all.sort((a, b) => b.trainScore - a.trainScore);

  const finalists = all.slice(0, 3).map((c) => ({ ...c, validate: validateEval(c.id, c.params) }));
  finalists.sort((a, b) => score(b.validate) - score(a.validate));

  const bh = buyHold(candles.slice(-validateDays));
  const best = finalists[0];
  // 시험 기간에서 단순 보유가 최고 전략을 이겼거나, 최고 전략이 매매를 아예 안 했다면
  // 정직하게 "보유"를 최종 답으로 선언한다.
  const verdict =
    score(bh) > score(best.validate) || best.validate.tradeCount === 0 ? "hold" : "strategy";
  return {
    verdict,
    period: {
      train: `${train[0].date} ~ ${train[train.length - 1].date}`,
      validate: `${candles[candles.length - validateDays].date} ~ ${candles[candles.length - 1].date}`,
    },
    recommendation: {
      id: best.id,
      params: best.params,
      label: best.label,
      validate: best.validate,
      beatsBuyHold: best.validate.totalReturn > bh.totalReturn,
    },
    finalists,
    buyHoldValidate: bh,
    candidatesTried: all.length,
  };
}
