// 전략 모음 + 전략 추천.
// 모든 전략은 두 가지 얼굴을 가진다:
//  - backtest(candles, params): 과거 데이터 성적표 (다음 날 시가 체결, 수수료·거래세 반영)
//  - signalNow(history, quote, position, params): 자동매매 엔진용 실시간 판정
const FEE = 0.00015; // 수수료 0.015%
const TAX = 0.0015; // 거래세 0.15% (매도)
// 슬리피지 0.1% — 시장가 주문은 호가 한두 틱 불리하게 체결된다.
// 0%로 가정하면 매매가 잦은 전략이 실제보다 훨씬 좋아 보인다 (13,000원대 종목 1틱 = 0.08%).
const SLIP = 0.001;
const CASH = 10_000_000;
const kw = (n) => Math.round(n).toLocaleString("ko-KR");

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
  // 한 트레이드 안에서 최악에 몇 % 물렸는지(MAE). 손절선을 정할 때 쓴다 —
  // 이 값보다 좁은 손절선은 전략이 이기던 트레이드도 중간에 잘라버린다.
  let entryPx = 0, worstMae = 0;
  for (let i = warmup; i < candles.length - 1; i++) {
    const want = signalAt(i, qty > 0);
    const px = candles[i + 1].open;
    if (want === "buy" && qty === 0) {
      const fill = px * (1 + SLIP); // 살 때는 조금 비싸게 체결된다
      qty = Math.floor(cash / (fill * (1 + FEE)));
      if (qty > 0) {
        entryCost = qty * fill * (1 + FEE);
        cash -= entryCost;
        entryPx = fill;
      }
    } else if (want === "sell" && qty > 0) {
      const proceeds = qty * px * (1 - SLIP) * (1 - FEE - TAX);
      cash += proceeds;
      sells++;
      if (proceeds > entryCost) wins++;
      qty = 0;
    }
    // 보유 중이면 그날 저가까지 얼마나 밀렸는지 기록한다
    if (qty > 0 && entryPx > 0) {
      worstMae = Math.max(worstMae, (entryPx - candles[i + 1].low) / entryPx);
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
    worstTradeDrawdown: worstMae,
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
    label: (p) =>
      `변동성 돌파 (k=${p.k}, ${p.roll !== false ? "갭업이면 이월" : "다음날 아침 청산"})`,
    grid: [
      { k: 0.5, roll: true },
      { k: 0.3, roll: true },
      { k: 0.5, roll: false },
      { k: 0.3, roll: false },
    ],
    // 당일 시가 + k×전일변동폭 돌파 시 매수.
    //
    // 청산 규칙 두 가지:
    //  - roll:false — 다음 날 시가에 무조건 청산 (원래 규칙). 보유 수명이 하루라 낙폭은
    //    작지만, 판 값보다 되사는 값이 늘 비싸서(청산가≈시가, 재매수가=시가+k×전일변동폭)
    //    "아침에 싸게 팔고 다시 비싸게 사는" 손실이 쌓인다.
    //  - roll:true  — 시가가 전일 종가보다 높게 출발하면(갭업) 팔지 않고 하루 더 들고 간다.
    //    갭업이 아니면 기존대로 청산하되, 그날은 되사지 않는다. 두 값 모두 09:00에
    //    알 수 있어 미래참조가 없다. 매매 횟수가 절반으로 줄어 비용도 절반이 된다.
    backtest(candles, p) {
      const roll = p.roll !== false;
      let equity = CASH, peak = CASH, mdd = 0, wins = 0, trades = 0;
      let entry = 0; // 0이면 미보유, 아니면 진입 체결가
      let exitedOn = -1; // 청산한 날 (이월 규칙에서는 그날 재매수 금지)
      let worstMae = 0; // 한 트레이드 안에서 최악에 몇 % 물렸나
      for (let i = 1; i < candles.length; i++) {
        const d = candles[i];
        // ① 아침 — 보유 중이면 청산할지 판정
        if (entry > 0) {
          const gapUp = d.open > candles[i - 1].close;
          if (!roll || !gapUp) {
            const net = ((d.open * (1 - SLIP)) / entry) * (1 - FEE) * (1 - FEE - TAX);
            equity *= net;
            trades++;
            if (net > 1) wins++;
            entry = 0;
            if (roll) exitedOn = i;
          }
        }
        // ② 장중 — 미보유이고 오늘 청산한 게 아니면 돌파 여부 확인
        //    (마지막 날은 청산할 다음 날이 없으므로 진입하지 않는다)
        if (entry === 0 && i !== exitedOn && i < candles.length - 1) {
          const target = d.open + p.k * (candles[i - 1].high - candles[i - 1].low);
          if (d.high >= target) entry = target * (1 + SLIP);
        }
        if (entry > 0) worstMae = Math.max(worstMae, (entry - d.low) / entry);
        // 보유 중에는 평가액 기준으로 낙폭을 잰다 (이월 규칙은 여러 날 들고 갈 수 있다)
        const eq = entry > 0 ? equity * (d.close / entry) : equity;
        if (eq > peak) peak = eq;
        mdd = Math.max(mdd, (peak - eq) / peak);
      }
      // 마지막에 들고 있으면 종가로 정리해서 성적에 포함한다
      if (entry > 0) {
        const last = candles[candles.length - 1].close;
        equity *= ((last * (1 - SLIP)) / entry) * (1 - FEE) * (1 - FEE - TAX);
        trades++;
      }
      return {
        totalReturn: equity / CASH - 1,
        maxDrawdown: mdd,
        tradeCount: trades,
        winRate: trades ? wins / trades : null,
        worstTradeDrawdown: worstMae,
        finalEquity: Math.round(equity),
      };
    },
    signalNow(history, quote, position, p) {
      const prev = history[history.length - 1];
      if (!prev) return { signal: null, note: "데이터 부족" };
      const roll = p.roll !== false;
      const target = quote.open + p.k * (prev.high - prev.low);
      // 어제(또는 그 전에) 산 포지션은 새 날 첫 확인 때 판정한다
      if (position && position.date && position.date < quote.today) {
        if (roll && quote.open > prev.close) {
          return {
            signal: null,
            note: `갭업 출발 (시가 ${kw(quote.open)} > 전일 종가 ${kw(prev.close)}) — 팔지 않고 이월 보유`,
          };
        }
        return {
          signal: "sell",
          note: roll ? "갭업이 아니어서 아침 청산" : "다음날 아침 청산 규칙",
          // 이월 규칙에서는 청산한 날 되사지 않는다 (되사는 값이 늘 더 비싸다)
          blockRebuyToday: roll,
        };
      }
      if (!position && quote.price >= target) {
        return { signal: "buy", note: `돌파선 ${kw(target)} 넘음` };
      }
      return { signal: null, note: `돌파선 ${kw(target)}` };
    },
  },
};

// 단순 보유 성적 (비교 기준)
export function buyHold(candles) {
  const start = candles[0].open, end = candles[candles.length - 1].close;
  let peak = 0, mdd = 0, worstMae = 0;
  for (const c of candles) {
    if (c.close > peak) peak = c.close;
    mdd = Math.max(mdd, (peak - c.close) / peak);
    worstMae = Math.max(worstMae, (start - c.low) / start);
  }
  return {
    totalReturn: (end * (1 - SLIP) * (1 - FEE - TAX)) / (start * (1 + SLIP) * (1 + FEE)) - 1,
    maxDrawdown: mdd,
    tradeCount: 1,
    winRate: null,
    worstTradeDrawdown: worstMae,
  };
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
  // 3자 대결로 판정한다: 최고 전략 vs 단순 보유 vs 현금(아무것도 안 하기, 점수 0).
  //  - strategy: 실제로 매매한 전략이 플러스 점수로 보유·현금을 모두 이김
  //  - hold:     보유가 플러스 점수로 이김
  //  - avoid:    현금이 최선 — 이 종목은 최근 1년 기준 손대지 않는 게 나았음
  const bhScore = score(bh);
  const bestScore = score(best.validate);
  let verdict = "avoid";
  if (bestScore > 0 && bestScore >= bhScore && best.validate.tradeCount > 0) verdict = "strategy";
  else if (bhScore > 0 && bh.totalReturn > 0) verdict = "hold";
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
