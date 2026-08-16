// 일봉 데이터 로컬 저장소. data/daily/<종목코드>.json 에 날짜 오름차순으로 저장한다.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

function dailyPath(stockCode) {
  return path.join(loadConfig().root, "data", "daily", `${stockCode}.json`);
}

export function loadDaily(stockCode) {
  try {
    return JSON.parse(fs.readFileSync(dailyPath(stockCode), "utf8"));
  } catch {
    return [];
  }
}

// 기존 데이터와 병합(날짜 기준 중복 제거) 후 저장. 저장된 총 건수를 반환한다.
export function saveDaily(stockCode, candles) {
  const byDate = new Map();
  for (const candle of [...loadDaily(stockCode), ...candles]) {
    byDate.set(candle.date, candle);
  }
  const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const filePath = dailyPath(stockCode);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged));
  return merged.length;
}
