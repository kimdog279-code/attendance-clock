// 커맨드라인 인터페이스.
// 사용법:
//   node src/cli.js price 005930           # 현재가 조회 (삼성전자)
//   node src/cli.js daily 005930 20250101  # 일봉 조회 (시작일 생략 가능)
//   node src/cli.js balance                # 계좌 잔고
//   node src/cli.js buy 005930 1           # 시장가 1주 매수
//   node src/cli.js buy 005930 1 60000     # 지정가 매수
//   node src/cli.js sell 005930 1 [가격]   # 매도
import { loadConfig } from "./config.js";
import { getPrice, getDailyChart } from "./api/quotations.js";
import { buy, sell } from "./api/orders.js";
import { getBalance } from "./api/balance.js";

const won = (n) => Number(n).toLocaleString("ko-KR");

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();
  console.log(`[모드: ${config.mode === "paper" ? "모의투자" : "⚠ 실전투자"}]\n`);

  switch (command) {
    case "price": {
      const [code] = args;
      if (!code) return usage();
      const p = await getPrice(code);
      const sign = p.change >= 0 ? "▲" : "▼";
      console.log(`${p.code} 현재가: ${won(p.price)}원 ${sign}${won(Math.abs(p.change))} (${p.changeRate}%)`);
      console.log(`시가 ${won(p.open)} / 고가 ${won(p.high)} / 저가 ${won(p.low)} / 거래량 ${won(p.volume)}`);
      console.log(`시총 ${won(p.marketCap)}억 / PER ${p.per} / PBR ${p.pbr}`);
      break;
    }

    case "daily": {
      const [code, from, to] = args;
      if (!code) return usage();
      const rows = await getDailyChart(code, { from, to });
      for (const r of rows) {
        console.log(`${r.date}  시 ${won(r.open)}  고 ${won(r.high)}  저 ${won(r.low)}  종 ${won(r.close)}  량 ${won(r.volume)}`);
      }
      console.log(`\n총 ${rows.length}건`);
      break;
    }

    case "balance": {
      const b = await getBalance();
      if (b.holdings.length === 0) {
        console.log("보유 종목 없음");
      }
      for (const h of b.holdings) {
        const sign = h.profitLoss >= 0 ? "+" : "";
        console.log(`${h.name}(${h.code})  ${won(h.qty)}주  평단 ${won(h.avgPrice)}  현재 ${won(h.currentPrice)}  손익 ${sign}${won(h.profitLoss)}원 (${sign}${h.profitLossRate}%)`);
      }
      console.log(`\n예수금 ${won(b.cash)}원 / 총평가 ${won(b.totalEval)}원 / 평가손익 ${won(b.totalProfitLoss)}원`);
      break;
    }

    case "buy":
    case "sell": {
      const [code, qty, price] = args;
      if (!code || !qty) return usage();
      const fn = command === "buy" ? buy : sell;
      const result = await fn(code, Number(qty), price ? Number(price) : undefined);
      console.log(`주문 접수됨 — 주문번호 ${result.orderNo} (${result.message})`);
      break;
    }

    default:
      usage();
  }
}

function usage() {
  console.log(
    [
      "사용법:",
      "  node src/cli.js price <종목코드>",
      "  node src/cli.js daily <종목코드> [시작일 YYYYMMDD] [종료일 YYYYMMDD]",
      "  node src/cli.js balance",
      "  node src/cli.js buy <종목코드> <수량> [지정가]",
      "  node src/cli.js sell <종목코드> <수량> [지정가]",
    ].join("\n")
  );
}

main().catch((err) => {
  console.error(`오류: ${err.message}`);
  process.exit(1);
});
