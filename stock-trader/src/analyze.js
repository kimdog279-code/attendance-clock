// 매매 기록 분석 — data/auto-trade.log를 읽어 실제 체결 손익을 계산한다.
// "왜 조금씩 잃었나"를 수수료·세금과 매매 자체의 손익으로 분리해서 보여준다.
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./config.js";

const FEE = 0.00015; // 위탁 수수료(편도) 0.015%
const TAX = 0.0015; // 증권거래세 0.15% (매도 시) — 근사치

// [20260818 10:42][실전] 매수 주문 007660 2주 @ 103000
// [20260817 10:42] 매도 주문 007660 2주 @ 105000   (구버전: 모드 표기 없음)
// 손절 주문도 매도로 집계한다 (뒤에 붙는 [매수가 · 등락 · 전략] 메모는 무시)
const LINE = /^\[(\d{8})\s+(\d{2}:\d{2})\](?:\[(실전|모의)\])?\s+(매수|매도|손절) 주문\s+(\d{6})\s+([\d,]+)주 @ ([\d,]+)/;

export function parseLog() {
  const file = path.join(projectRoot(), "data", "auto-trade.log");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const [, date, time, mode, side, code, qtyStr, priceStr] = m;
    rows.push({
      date, time,
      mode: mode ?? "미상",
      side: side === "매수" ? "buy" : "sell",
      stopLoss: side === "손절",
      code,
      qty: Number(qtyStr.replaceAll(",", "")),
      price: Number(priceStr.replaceAll(",", "")),
    });
  }
  return rows;
}

// 종목별로 매수→매도를 선입선출로 짝지어 실현 손익을 만든다
function pairTrades(rows) {
  const open = new Map(); // code → [{date, price, qty}, ...]
  const trades = [];
  for (const r of rows) {
    if (r.side === "buy") {
      if (!open.has(r.code)) open.set(r.code, []);
      open.get(r.code).push({ ...r });
      continue;
    }
    let remaining = r.qty;
    const lots = open.get(r.code) ?? [];
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const qty = Math.min(remaining, lot.qty);
      const buyCost = lot.price * qty * (1 + FEE);
      const sellGain = r.price * qty * (1 - FEE - TAX);
      trades.push({
        code: r.code,
        qty,
        buyDate: lot.date, buyPrice: lot.price,
        sellDate: r.date, sellPrice: r.price,
        grossPnl: (r.price - lot.price) * qty, // 수수료 전
        cost: lot.price * qty * FEE + r.price * qty * (FEE + TAX), // 수수료+세금
        netPnl: sellGain - buyCost,
        heldDays: dayDiff(lot.date, r.date),
      });
      lot.qty -= qty;
      remaining -= qty;
      if (lot.qty === 0) lots.shift();
    }
  }
  const stillOpen = [];
  for (const [code, lots] of open) for (const l of lots) if (l.qty > 0) stillOpen.push({ code, ...l });
  return { trades, stillOpen };
}

function dayDiff(a, b) {
  const d = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  return Math.round((d(b) - d(a)) / 86400000);
}

export function analyzeTrades({ mode } = {}) {
  let rows = parseLog();
  if (mode) rows = rows.filter((r) => r.mode === mode || r.mode === "미상");
  const { trades, stillOpen } = pairTrades(rows);

  if (trades.length === 0) {
    return { trades: [], stillOpen, summary: null, byStock: [] };
  }

  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const invested = sum((t) => t.buyPrice * t.qty);

  const summary = {
    count: trades.length,
    period: `${trades[0].buyDate} ~ ${trades[trades.length - 1].sellDate}`,
    grossPnl: Math.round(sum((t) => t.grossPnl)), // 수수료 전 매매 손익
    cost: Math.round(sum((t) => t.cost)), // 수수료+세금 합계
    netPnl: Math.round(sum((t) => t.netPnl)), // 실제 손익
    invested: Math.round(invested),
    winRate: wins.length / trades.length,
    avgWin: wins.length ? Math.round(wins.reduce((s, t) => s + t.netPnl, 0) / wins.length) : 0,
    avgLoss: losses.length ? Math.round(losses.reduce((s, t) => s + t.netPnl, 0) / losses.length) : 0,
    avgHeldDays: sum((t) => t.heldDays) / trades.length,
    // 매매당 평균 수익률 (수수료 전 / 후)
    avgGrossRate: sum((t) => (t.sellPrice - t.buyPrice) / t.buyPrice) / trades.length,
    costRate: sum((t) => t.cost) / invested,
  };

  const byCode = new Map();
  for (const t of trades) {
    const e = byCode.get(t.code) ?? { code: t.code, count: 0, netPnl: 0, cost: 0, grossPnl: 0 };
    e.count++; e.netPnl += t.netPnl; e.cost += t.cost; e.grossPnl += t.grossPnl;
    byCode.set(t.code, e);
  }
  const byStock = [...byCode.values()]
    .map((e) => ({ ...e, netPnl: Math.round(e.netPnl), cost: Math.round(e.cost), grossPnl: Math.round(e.grossPnl) }))
    .sort((a, b) => a.netPnl - b.netPnl);

  return { trades: trades.slice(-60), stillOpen, summary, byStock };
}
