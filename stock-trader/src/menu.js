// 초보자용 메뉴 프로그램. 번호를 골라서 실행한다.
// 실행: node src/menu.js (또는 시작하기.bat 더블클릭)
import { configExists, loadConfig } from "./config.js";
import { runSetup } from "./setup.js";
import { ask, inputClosed, closePrompt } from "./prompt.js";

const won = (n) => Number(n).toLocaleString("ko-KR");

async function askStockCode() {
  const code = (await ask("종목코드 6자리 (그냥 Enter = 삼성전자 005930): ")).trim();
  return code === "" ? "005930" : code;
}

async function showPrice() {
  const { getPrice } = await import("./api/quotations.js");
  const code = await askStockCode();
  const p = await getPrice(code);
  const sign = p.change >= 0 ? "▲" : "▼";
  console.log(`\n${code} 현재가: ${won(p.price)}원 ${sign}${won(Math.abs(p.change))} (${p.changeRate}%)`);
  console.log(`시가 ${won(p.open)} / 고가 ${won(p.high)} / 저가 ${won(p.low)} / 거래량 ${won(p.volume)}`);
}

async function showBalance() {
  const { getBalance } = await import("./api/balance.js");
  const b = await getBalance();
  console.log();
  if (b.holdings.length === 0) console.log("보유 종목이 없습니다.");
  for (const h of b.holdings) {
    const sign = h.profitLoss >= 0 ? "+" : "";
    console.log(`${h.name}(${h.code})  ${won(h.qty)}주  평단 ${won(h.avgPrice)}원  현재 ${won(h.currentPrice)}원  손익 ${sign}${won(h.profitLoss)}원 (${sign}${h.profitLossRate}%)`);
  }
  console.log(`\n예수금(현금): ${won(b.cash)}원 / 총평가: ${won(b.totalEval)}원 / 평가손익: ${won(b.totalProfitLoss)}원`);
}

async function collect() {
  const { collectDaily } = await import("./collect.js");
  const code = await askStockCode();
  console.log("\n2020년부터 오늘까지 일봉(하루 단위 주가) 데이터를 내려받습니다. 십수 초 걸려요.");
  const result = await collectDaily(code, "20200101");
  console.log(`\n완료! 총 ${result.total}일치 데이터가 저장됐습니다.`);
}

async function backtest() {
  const { loadDaily } = await import("./store.js");
  const { smaCross } = await import("./backtest.js");
  const code = await askStockCode();
  const candles = loadDaily(code);
  if (candles.length === 0) {
    console.log("\n이 종목의 데이터가 아직 없습니다. 먼저 '3. 데이터 수집'을 실행해주세요.");
    return;
  }
  const r = smaCross(candles);
  const pct = (x) => (x * 100).toFixed(2) + "%";
  console.log(`\n전략: 5일/20일 이동평균 골든크로스 매수, 데드크로스 매도`);
  console.log(`기간: ${r.period}\n`);
  console.log(`이 전략을 썼다면:      ${pct(r.totalReturn)}  (1,000만원 → ${won(r.finalEquity)}원)`);
  console.log(`그냥 사서 들고있었다면: ${pct(r.buyHoldReturn)}`);
  console.log(`중간 최대 하락폭(MDD): ${pct(r.maxDrawdown)}`);
  console.log(`매매 ${r.tradeCount}회, 이긴 비율 ${r.winRate == null ? "-" : pct(r.winRate)}`);
  console.log("\n※ 과거에 통했다고 미래에도 통한다는 보장은 없습니다!");
}

async function order(side) {
  const { buy, sell } = await import("./api/orders.js");
  const { getPrice } = await import("./api/quotations.js");
  const label = side === "buy" ? "매수" : "매도";

  const code = await askStockCode();
  const p = await getPrice(code);
  console.log(`\n${code} 현재가: ${won(p.price)}원`);

  const qtyStr = (await ask(`몇 주를 ${label}할까요?: `)).trim();
  const qty = Number(qtyStr);
  if (!Number.isInteger(qty) || qty <= 0) {
    console.log("수량은 1 이상의 숫자로 입력해주세요.");
    return;
  }

  console.log(`\n[확인] ${code} ${qty}주 시장가 ${label} (약 ${won(p.price * qty)}원)`);
  const ok = (await ask("진행할까요? (y 입력 시 주문): ")).trim().toLowerCase();
  if (ok !== "y") {
    console.log("취소했습니다.");
    return;
  }

  const fn = side === "buy" ? buy : sell;
  const result = await fn(code, qty);
  console.log(`\n✅ 주문이 접수됐습니다! 주문번호 ${result.orderNo}`);
  console.log("(장 운영시간이 아니면 다음 개장 때 처리됩니다. '2. 내 계좌'에서 확인하세요)");
}

async function checkUpdate() {
  try {
    const { checkForUpdate, applyUpdate } = await import("./update.js");
    const remoteVersion = await checkForUpdate();
    if (!remoteVersion) return false;

    console.log(`\n🔔 새 버전(v${remoteVersion})이 나왔습니다!`);
    const ok = (await ask("지금 업데이트할까요? (y 입력 시 업데이트): ")).trim().toLowerCase();
    if (ok !== "y") return false;

    const count = await applyUpdate();
    console.log(`\n✅ 업데이트 완료! (${count}개 파일 교체)`);
    console.log("프로그램을 껐다가 다시 켜주세요. 키 설정과 수집한 데이터는 그대로 유지됩니다.");
    return true;
  } catch (err) {
    console.log(`업데이트 중 문제가 생겨 건너뜁니다: ${err.message}`);
    return false;
  }
}

async function autoTrade() {
  const { startEngine } = await import("./engine.js");
  const code = await askStockCode();

  console.log("\n어떤 방식으로 돌릴까요?");
  console.log("1. 연습 모드 — 신호가 오면 알려주기만 (추천, 먼저 이걸로 신뢰를 확인하세요)");
  console.log("2. 주문 모드 — 신호가 오면 모의투자 계좌에 진짜 주문");
  const mode = (await ask("번호 (그냥 Enter = 1): ")).trim();

  const stopPromise = ask(""); // Enter 입력을 기다렸다가 엔진을 멈춘다
  await startEngine({ code, live: mode === "2", stopPromise });
}

async function main() {
  console.log("\n■■■ 주식 매매 프로그램 (모의투자) ■■■");

  if (await checkUpdate()) {
    closePrompt();
    return;
  }

  if (!configExists()) {
    await runSetup();
  }

  while (true) {
    let modeLabel = "설정 안 됨";
    try {
      modeLabel = loadConfig().mode === "paper" ? "모의투자" : "⚠ 실전투자";
    } catch {}

    console.log(`\n──────── 메뉴 [${modeLabel}] ────────`);
    console.log("1. 현재가 조회");
    console.log("2. 내 계좌 (잔고·수익률)");
    console.log("3. 데이터 수집 (백테스트 준비)");
    console.log("4. 백테스트 (과거 데이터로 전략 검증)");
    console.log("5. 매수 주문");
    console.log("6. 매도 주문");
    console.log("7. 자동매매 (신호 감지·자동 주문)");
    console.log("9. 설정 다시 하기");
    console.log("0. 종료");

    const choice = (await ask("\n번호를 입력하세요: ")).trim();
    if (choice === "0" || (choice === "" && inputClosed())) break;

    try {
      if (choice === "1") await showPrice();
      else if (choice === "2") await showBalance();
      else if (choice === "3") await collect();
      else if (choice === "4") await backtest();
      else if (choice === "5") await order("buy");
      else if (choice === "6") await order("sell");
      else if (choice === "7") await autoTrade();
      else if (choice === "9") await runSetup();
      else console.log("1~7, 9, 0 중에서 골라주세요.");
    } catch (err) {
      console.log(`\n문제가 생겼어요: ${err.message}`);
      console.log("인터넷 연결과 설정(메뉴 9)을 확인한 뒤 다시 시도해보세요.");
    }
  }

  console.log("프로그램을 종료합니다. 안녕히!");
  closePrompt();
}

main().catch((err) => {
  console.error(`예상치 못한 오류: ${err.message}`);
  closePrompt();
});
