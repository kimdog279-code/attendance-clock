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

export function loadConfig() {
  if (cached) return cached;

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      "config.json이 없습니다.\n" +
        "  1) KIS Developers(https://apiportal.koreainvestment.com)에서 앱 키를 발급받으세요.\n" +
        "  2) config.example.json을 config.json으로 복사한 뒤 값을 채우세요."
    );
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  for (const key of ["appKey", "appSecret", "accountNo"]) {
    if (!raw[key] || raw[key].includes("발급받은")) {
      console.error(`config.json의 "${key}" 값을 채워주세요.`);
      process.exit(1);
    }
  }

  const mode = raw.mode === "real" ? "real" : "paper";
  const [cano, acntPrdtCd = "01"] = raw.accountNo.split("-");
  if (!/^\d{8}$/.test(cano)) {
    console.error('accountNo는 "계좌번호8자리-01" 형식이어야 합니다. 예: "12345678-01"');
    process.exit(1);
  }

  cached = {
    mode,
    baseUrl: BASE_URLS[mode],
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
