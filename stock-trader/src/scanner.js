// 종목 스캐너 — "오늘 시장에서 움직이는 종목"을 자동으로 찾아 점수화한다.
// 1) 거래량 상위 종목을 증권사 API에서 가져오고 (안 되면 내장 대형주 목록 + 관심종목)
// 2) 종목마다 최근 일봉(약 100일)을 받아 추세·수익률·거래대금을 계산해
// 3) 상위 후보를 이유와 함께 돌려준다. 예측이 아니라 "지금 관찰할 가치" 순위다.
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./config.js";
import { kisRequest } from "./kisClient.js";
import { getDailyChart } from "./api/quotations.js";
import { saveDaily } from "./store.js";

const BUILTIN = [
  ["005930", "삼성전자"], ["000660", "SK하이닉스"], ["373220", "LG에너지솔루션"],
  ["207940", "삼성바이오로직스"], ["005380", "현대차"], ["000270", "기아"],
  ["068270", "셀트리온"], ["005490", "POSCO홀딩스"], ["035420", "NAVER"],
  ["035720", "카카오"], ["051910", "LG화학"], ["006400", "삼성SDI"],
  ["105560", "KB금융"], ["055550", "신한지주"], ["012450", "한화에어로스페이스"],
  ["042700", "한미반도체"], ["007660", "이수페타시스"], ["009150", "삼성전기"],
  ["267260", "HD현대일렉트릭"], ["010120", "LS ELECTRIC"], ["298040", "효성중공업"],
  ["018260", "삼성SDS"],
];

// 거래량 상위 종목 (실전/모의 지원 여부가 달라 실패하면 호출부에서 대체 목록 사용)
async function rankUniverse() {
  const data = await kisRequest({
    path: "/uapi/domestic-stock/v1/quotations/volume-rank",
    trId: "FHPST01710000",
    params: {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_COND_SCR_DIV_CODE: "20171",
      FID_INPUT_ISCD: "0000",
      FID_DIV_CLS_CODE: "0",
      FID_BLNG_CLS_CODE: "3", // 거래대금 기준
      FID_TRGT_CLS_CODE: "111111111",
      FID_TRGT_EXLS_CLS_CODE: "0000000000",
      FID_INPUT_PRICE_1: "",
      FID_INPUT_PRICE_2: "",
      FID_VOL_CNT: "",
      FID_INPUT_DATE_1: "",
    },
  });
  return (data.output ?? [])
    .map((r) => ({ code: r.mksc_shrn_iscd, name: r.hts_kor_isnm }))
    .filter((r) => /^\d{6}$/.test(r.code));
}

function fallbackUniverse() {
  const list = [];
  try {
    const w = JSON.parse(fs.readFileSync(path.join(projectRoot(), "data", "watchlist.json"), "utf8"));
    for (const it of [...(w.favorites ?? []), ...(w.recent ?? [])]) {
      if (it.name) list.push({ code: it.code, name: it.name });
    }
  } catch {}
  for (const [code, name] of BUILTIN) list.push({ code, name });
  return list;
}

const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

function metrics(candles) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const sma = (n) => avg(closes.slice(-n));
  const ret20 = last / closes[closes.length - 21] - 1;
  const ret60 = last / closes[closes.length - 61] - 1;
  const aligned = sma(5) > sma(20) && sma(20) > sma(60); // 정배열 = 상승 추세 형태
  const dailyRets = [];
  for (let i = closes.length - 20; i < closes.length; i++) dailyRets.push(closes[i] / closes[i - 1] - 1);
  const mean = avg(dailyRets);
  const vol = Math.sqrt(avg(dailyRets.map((r) => (r - mean) ** 2))) * Math.sqrt(252);
  const avgValue = avg(candles.slice(-20).map((c) => c.close * c.volume)); // 하루 평균 거래대금
  return { price: last, ret20, ret60, aligned, vol, avgValue };
}

export async function scanStocks({ limit = 25 } = {}) {
  let universe;
  let source = "rank";
  try {
    universe = await rankUniverse();
    if (universe.length < 5) throw new Error("결과 부족");
  } catch {
    source = "fallback";
    universe = fallbackUniverse();
  }

  // 중복 제거 후 상위 limit개만 상세 조사
  const seen = new Set();
  universe = universe.filter((u) => !seen.has(u.code) && seen.add(u.code)).slice(0, limit);

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  const from = new Date(Date.now() - 210 * 24 * 3600 * 1000).toISOString().slice(0, 10).replaceAll("-", "");

  const results = [];
  for (const u of universe) {
    try {
      const candles = await getDailyChart(u.code, { from, to: today });
      if (candles.length < 61) continue;
      saveDaily(u.code, candles); // 차트·후속 분석에서 재활용
      results.push({ ...u, ...metrics(candles) });
    } catch {
      // 개별 종목 실패는 건너뛴다 (거래정지 등)
    }
  }

  // 정렬: 상승 추세(정배열) 우선, 그 안에서 20일 수익률 순
  results.sort((a, b) => Number(b.aligned) - Number(a.aligned) || b.ret20 - a.ret20);
  return { source, scanned: results.length, candidates: results.slice(0, 10) };
}
