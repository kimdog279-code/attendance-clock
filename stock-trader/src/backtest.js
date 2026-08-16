// 백테스팅 엔진 — 이동평균 골든/데드크로스 전략.
// 현실성을 위해:
//  - 신호 발생 다음 날 시가에 체결한다고 가정 (종가 신호를 당일 체결로 계산하면 수익률이 부풀려짐)
//  - 수수료는 매수/매도 양쪽, 거래세는 매도에만 부과
export function smaCross(candles, options = {}) {
  const {
    shortPeriod = 5,
    longPeriod = 20,
    initialCash = 10_000_000,
    feeRate = 0.00015, // 위탁 수수료 0.015%
    taxRate = 0.0015, // 증권거래세 0.15% (매도 시)
  } = options;

  if (candles.length < longPeriod + 2) {
    throw new Error(`데이터가 부족합니다 (${candles.length}건, 최소 ${longPeriod + 2}건 필요)`);
  }

  const closes = candles.map((c) => c.close);
  const sma = (n, i) => {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += closes[j];
    return sum / n;
  };

  let cash = initialCash;
  let qty = 0;
  let entryCost = 0; // 보유 포지션의 총 매수금액 (수수료 포함)
  const trades = [];
  let peak = initialCash;
  let maxDrawdown = 0;

  for (let i = longPeriod; i < candles.length - 1; i++) {
    const shortNow = sma(shortPeriod, i);
    const longNow = sma(longPeriod, i);
    const shortPrev = sma(shortPeriod, i - 1);
    const longPrev = sma(longPeriod, i - 1);
    const execPrice = candles[i + 1].open; // 다음 날 시가 체결

    const goldenCross = shortPrev <= longPrev && shortNow > longNow;
    const deadCross = shortPrev >= longPrev && shortNow < longNow;

    if (goldenCross && qty === 0) {
      const buyQty = Math.floor(cash / (execPrice * (1 + feeRate)));
      if (buyQty > 0) {
        entryCost = buyQty * execPrice * (1 + feeRate);
        cash -= entryCost;
        qty = buyQty;
        trades.push({ type: "buy", date: candles[i + 1].date, price: execPrice, qty: buyQty });
      }
    } else if (deadCross && qty > 0) {
      const proceeds = qty * execPrice * (1 - feeRate - taxRate);
      cash += proceeds;
      trades.push({
        type: "sell",
        date: candles[i + 1].date,
        price: execPrice,
        qty,
        profit: proceeds - entryCost,
      });
      qty = 0;
      entryCost = 0;
    }

    // 일별 평가금액으로 최대낙폭(MDD) 계산
    const equity = cash + qty * candles[i + 1].close;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const last = candles[candles.length - 1];
  const finalEquity = cash + qty * last.close;
  const sells = trades.filter((t) => t.type === "sell");
  const wins = sells.filter((t) => t.profit > 0);

  // 비교 기준: 같은 기간 단순 보유(buy & hold) 수익률
  const holdFrom = candles[longPeriod + 1].open;
  const buyHoldReturn = (last.close * (1 - feeRate - taxRate)) / (holdFrom * (1 + feeRate)) - 1;

  return {
    period: `${candles[longPeriod + 1].date} ~ ${last.date}`,
    initialCash,
    finalEquity: Math.round(finalEquity),
    totalReturn: finalEquity / initialCash - 1,
    buyHoldReturn,
    maxDrawdown,
    tradeCount: sells.length,
    winRate: sells.length > 0 ? wins.length / sells.length : null,
    openPosition: qty > 0 ? { qty, lastClose: last.close } : null,
    trades,
  };
}
