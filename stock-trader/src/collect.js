// 일봉 수집기. KIS 일봉 API는 1회 최대 100건이므로
// 기간을 거슬러 올라가며 반복 조회해서 data/daily/에 적재한다.
import { getDailyChart } from "./api/quotations.js";
import { loadConfig } from "./config.js";
import { saveDaily } from "./store.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dayBefore(yyyymmdd) {
  const d = new Date(
    Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8))
  );
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

export async function collectDaily(stockCode, from = "20200101") {
  const config = loadConfig();
  // 호출 제한: 모의투자 초당 2건, 실전 초당 20건 — 넉넉히 대기
  // (경계에 걸리는 경우가 있어 모의투자는 1.1초로 여유 있게)
  const waitMs = config.mode === "paper" ? 1100 : 150;

  let to = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const collected = [];

  while (true) {
    const rows = await getDailyChart(stockCode, { from, to });
    if (rows.length === 0) break;

    collected.unshift(...rows);
    const earliest = rows[0].date;
    console.log(`  ${earliest} ~ ${rows[rows.length - 1].date}  ${rows.length}건`);

    if (earliest <= from) break;
    to = dayBefore(earliest);
    await sleep(waitMs);
  }

  const total = saveDaily(stockCode, collected);
  return { fetched: collected.length, total };
}
