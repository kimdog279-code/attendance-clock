// 초보자용 설정 마법사. 키를 물어봐서 config.json을 만들어준다.
import fs from "node:fs";
import { configPath, resetConfigCache } from "./config.js";
import { ask, inputClosed } from "./prompt.js";

export async function runSetup() {
  console.log("=== 처음 설정을 시작합니다 ===");
  console.log("KIS Developers 포털에서 발급받은 모의투자용 키를 준비해주세요.");
  console.log("(값을 붙여넣을 때 앞뒤 공백은 자동으로 지워집니다)\n");

  const appKey = (await ask("① APP Key (짧은 문자열): ")).trim();
  const appSecret = (await ask("② APP Secret (아주 긴 문자열): ")).trim();

  let accountNo = "";
  while (true) {
    accountNo = (await ask("③ 모의투자 계좌번호 (숫자 8자리, 예: 12345678): "))
      .trim()
      .replaceAll(" ", "");
    if (/^\d{8}$/.test(accountNo)) {
      accountNo = accountNo + "-01";
      break;
    }
    if (/^\d{8}-\d{2}$/.test(accountNo)) break;
    if (inputClosed()) return false;
    console.log("  → 숫자 8자리로 입력해주세요. 다시 입력합니다.");
  }

  if (!appKey || appSecret.length < 20) {
    console.log("\n입력값이 비어 있거나 너무 짧습니다. 처음부터 다시 실행해주세요.");
    return false;
  }

  const config = {
    mode: "paper",
    appKey,
    appSecret,
    accountNo,
    allowRealOrders: false,
    maxOrderAmount: 100000,
  };
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  resetConfigCache();

  console.log("\n설정 저장 완료! (config.json — 이 파일은 내 컴퓨터에만 저장됩니다)");
  console.log("이제 연결 테스트를 해볼게요...\n");

  try {
    const { getPrice } = await import("./api/quotations.js");
    const p = await getPrice("005930");
    console.log(`✅ 연결 성공! 삼성전자 현재가: ${p.price.toLocaleString("ko-KR")}원`);
    return true;
  } catch (err) {
    console.log("❌ 연결에 실패했습니다: " + err.message);
    console.log(
      "\n확인해볼 것:\n" +
        "  - 인터넷이 연결되어 있나요?\n" +
        "  - 키가 '모의투자용'이 맞나요? (실전용 키는 여기서 동작하지 않습니다)\n" +
        "  - 키를 복사할 때 일부가 잘리지 않았나요?\n" +
        "메뉴에서 '9. 설정 다시 하기'로 언제든 다시 입력할 수 있습니다."
    );
    return false;
  }
}
