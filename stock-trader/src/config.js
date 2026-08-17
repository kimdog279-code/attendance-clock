// config.json 로드 및 검증. config.example.json을 복사해 config.json을 만들어 사용한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(ROOT, "config.json");

const BASE_URLS = {
  real: "https://openapi.koreainvestment.com:9443",
  paper: "https://openapivts.koreainvestment.com:29443",
};

let cached = null;

export function configExists() {
  return fs.existsSync(CONFIG_PATH);
}

export function configPath() {
  return CONFIG_PATH;
}

export function resetConfigCache() {
  cached = null;
}

export function loadConfig() {
  if (cached) return cached;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      "설정(config.json)이 아직 없습니다. 설정 마법사를 먼저 실행해주세요. " +
        "(메뉴 프로그램을 실행하면 자동으로 물어봅니다)"
    );
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  for (const key of ["appKey", "appSecret", "accountNo"]) {
    if (!raw[key] || raw[key].includes("발급받은")) {
      throw new Error(`config.json의 "${key}" 값이 비어 있습니다.`);
    }
  }

  const mode = raw.mode === "real" ? "real" : "paper";
  const [cano, acntPrdtCd = "01"] = raw.accountNo.split("-");
  if (!/^\d{8}$/.test(cano)) {
    throw new Error('accountNo는 "계좌번호8자리-01" 형식이어야 합니다. 예: "12345678-01"');
  }

  cached = {
    mode,
    // KIS_BASE_URL 환경변수는 테스트용 목(mock) 서버를 붙일 때만 사용
    baseUrl: process.env.KIS_BASE_URL ?? BASE_URLS[mode],
    appKey: raw.appKey,
    appSecret: raw.appSecret,
    cano,
    acntPrdtCd,
    allowRealOrders: raw.allowRealOrders === true,
    // 실전 주문 1건당 최대 금액(원). 실수로 큰 주문이 나가는 것을 막는다.
    maxOrderAmount: Number(raw.maxOrderAmount ?? 100000),
    root: ROOT,
  };
  return cached;
}
