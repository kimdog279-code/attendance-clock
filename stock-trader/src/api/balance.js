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
  return {
    holdings,
    stockValue, // 보유 주식 평가금액
    cash: Number(summary.dnca_tot_amt ?? 0), // 남은 현금(예수금)
    totalEval: Number(summary.tot_evlu_amt ?? 0), // 총 평가금액 (주식+현금)
    totalProfitLoss: Number(summary.evlu_pfls_smtl_amt ?? 0),
  };
}
