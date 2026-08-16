// 주문 API. 안전장치:
//  - mode가 "real"이면 config의 allowRealOrders가 true일 때만 주문을 허용한다.
//  - 모의투자에서 충분히 검증하기 전에는 allowRealOrders를 켜지 말 것.
import { loadConfig } from "../config.js";
import { kisRequest, trIdFor } from "../kisClient.js";

const ORD_DVSN = { limit: "00", market: "01" };

async function placeOrder({ side, stockCode, qty, price }) {
  const config = loadConfig();
  if (config.mode === "real" && !config.allowRealOrders) {
    throw new Error(
      "실전투자 모드에서 주문이 차단되었습니다. " +
        "정말 실제 주문을 내려면 config.json에서 allowRealOrders를 true로 설정하세요."
    );
  }

  const isMarketOrder = price == null;
  // 실전 tr_id 기준: 매수 TTTC0802U, 매도 TTTC0801U (모의는 V로 시작)
  const trId = trIdFor(side === "buy" ? "TTTC0802U" : "TTTC0801U");

  const data = await kisRequest({
    method: "POST",
    path: "/uapi/domestic-stock/v1/trading/order-cash",
    trId,
    body: {
      CANO: config.cano,
      ACNT_PRDT_CD: config.acntPrdtCd,
      PDNO: stockCode,
      ORD_DVSN: isMarketOrder ? ORD_DVSN.market : ORD_DVSN.limit,
      ORD_QTY: String(qty),
      ORD_UNPR: isMarketOrder ? "0" : String(price),
    },
  });

  return {
    orderNo: data.output?.ODNO,
    orderTime: data.output?.ORD_TMD,
    message: data.msg1,
  };
}

export function buy(stockCode, qty, price) {
  return placeOrder({ side: "buy", stockCode, qty, price });
}

export function sell(stockCode, qty, price) {
  return placeOrder({ side: "sell", stockCode, qty, price });
}
