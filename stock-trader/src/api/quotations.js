// 시세 조회 API. 시세 조회는 모의/실전 tr_id가 동일하다.
import { kisRequest } from "../kisClient.js";

// 주식 현재가 조회
export async function getPrice(stockCode) {
  const data = await kisRequest({
    path: "/uapi/domestic-stock/v1/quotations/inquire-price",
    trId: "FHKST01010100",
    params: {
      fid_cond_mrkt_div_code: "J", // J: 주식/ETF/ETN
      fid_input_iscd: stockCode,
    },
  });

  const o = data.output;
  return {
    code: stockCode,
    price: Number(o.stck_prpr), // 현재가
    change: Number(o.prdy_vrss), // 전일 대비
    changeRate: Number(o.prdy_ctrt), // 전일 대비율(%)
    open: Number(o.stck_oprc),
    high: Number(o.stck_hgpr),
    low: Number(o.stck_lwpr),
    volume: Number(o.acml_vol), // 누적 거래량
    marketCap: Number(o.hts_avls), // 시가총액(억)
    per: Number(o.per),
    pbr: Number(o.pbr),
  };
}

// 일/주/월봉 조회 (한 번에 최대 100건)
// period: "D"(일) | "W"(주) | "M"(월)
export async function getDailyChart(stockCode, { from, to, period = "D" } = {}) {
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const data = await kisRequest({
    path: "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    trId: "FHKST03010100",
    params: {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: stockCode,
      FID_INPUT_DATE_1: from ?? "20240101",
      FID_INPUT_DATE_2: to ?? today,
      FID_PERIOD_DIV_CODE: period,
      FID_ORG_ADJ_PRC: "0", // 0: 수정주가 반영
    },
  });

  return (data.output2 ?? [])
    .filter((row) => row.stck_bsop_date)
    .map((row) => ({
      date: row.stck_bsop_date,
      open: Number(row.stck_oprc),
      high: Number(row.stck_hgpr),
      low: Number(row.stck_lwpr),
      close: Number(row.stck_clpr),
      volume: Number(row.acml_vol),
    }))
    .reverse(); // 과거 → 최신 순으로 정렬
}
