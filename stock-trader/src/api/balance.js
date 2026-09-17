// 계좌 잔고 조회 API.
import { loadConfig } from "../config.js";
import { kisRequest, trIdFor } from "../kisClient.js";

export async function getBalance() {
  const config = loadConfig();
  const data = await kisRequest({
    path: "/uapi/domestic-stock/v1/trading/inquire-balance",
    trId: trIdFor("TTTC8434R"),
    params: {
      CANO: config.cano,
      ACNT_PRDT_CD: config.acntPrdtCd,
      AFHR_FLPR_YN: "N", // 시간외 단일가 여부
      OFL_YN: "",
      INQR_DVSN: "02", // 종목별 조회
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "00", // 전일매매 포함
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    },
  });

  const holdings = (data.output1 ?? [])
    .filter((row) => Number(row.hldg_qty) > 0)
    .map((row) => ({
      code: row.pdno,
      name: row.prdt_name,
      qty: Number(row.hldg_qty),
      avgPrice: Number(row.pchs_avg_pric), // 매입 평균가
      currentPrice: Number(row.prpr),
      profitLoss: Number(row.evlu_pfls_amt), // 평가손익
      profitLossRate: Number(row.evlu_pfls_rt),
    }));

  const summary = data.output2?.[0] ?? {};
  // 보유 주식 평가금액: 요약 필드를 우선 쓰고, 없으면 종목별 평가액 합산
  const stockValue =
    Number(summary.scts_evlu_amt ?? 0) ||
    holdings.reduce((sum, h) => sum + h.qty * h.currentPrice, 0);
  const totalEval = Number(summary.tot_evlu_amt ?? 0);
  // 남은 현금은 "정산 반영 후(D+2 예수금)" 기준으로 — 주식 매매 대금은
  // 2영업일 뒤 결제되므로 결제 전 예수금(dnca_tot_amt)은 실제와 다를 수 있다.
  const cashBeforeSettle = Number(summary.dnca_tot_amt ?? 0);
  const cash =
    Number(summary.prvs_rcdl_excc_amt ?? 0) ||
    (totalEval > 0 ? totalEval - stockValue : cashBeforeSettle);
  return {
    holdings,
    stockValue, // 보유 주식 평가금액
    cash, // 남은 현금 (정산 반영)
    cashBeforeSettle, // 정산 전 예수금 (참고용)
    totalEval, // 총 평가금액 (주식+현금)
    totalProfitLoss: Number(summary.evlu_pfls_smtl_amt ?? 0),
  };
}

// 매수가능금액 조회 — "이 종목을 지금 얼마어치 살 수 있나"를 증권사에 직접 묻는다.
// 잔고의 예수금은 미결제 대금 때문에 실제 주문가능액과 다를 수 있어서 이 API가 정확하다.
// 조회에 실패하면 null을 돌려주고, 호출부가 잔고 기준으로 대체하게 한다.
export async function getBuyableCash(stockCode, price) {
  const config = loadConfig();
  try {
    const data = await kisRequest({
      path: "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
      trId: trIdFor("TTTC8908R"),
      params: {
        CANO: config.cano,
        ACNT_PRDT_CD: config.acntPrdtCd,
        PDNO: stockCode,
        ORD_UNPR: String(price ?? 0),
        ORD_DVSN: price ? "00" : "01", // 지정가/시장가
        CMA_EVLU_AMT_ICLD_YN: "N",
        OVRS_ICLD_YN: "N",
      },
    });
    const o = data.output ?? {};
    // 미수(빚) 없이 살 수 있는 금액을 우선 사용한다
    const amount = Number(o.nrcvb_buy_amt ?? 0) || Number(o.ord_psbl_cash ?? 0);
    const qty = Number(o.nrcvb_buy_qty ?? 0);
    if (!amount && !qty) return null;
    return { amount, qty };
  } catch {
    return null;
  }
}
