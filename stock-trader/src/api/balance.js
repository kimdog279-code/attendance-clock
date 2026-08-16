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
  return {
    holdings,
    cash: Number(summary.dnca_tot_amt ?? 0), // 예수금
    totalEval: Number(summary.tot_evlu_amt ?? 0), // 총 평가금액
    totalProfitLoss: Number(summary.evlu_pfls_smtl_amt ?? 0),
  };
}
