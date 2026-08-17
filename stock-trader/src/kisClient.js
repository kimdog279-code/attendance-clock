// KIS REST API 공통 호출 래퍼.
// 인증 헤더를 붙이고, 응답의 rt_cd를 검사해 실패 시 msg1을 담아 throw한다.
import { loadConfig } from "./config.js";
import { getAccessToken } from "./token.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RATE_LIMIT_RETRIES = 5;

// 전역 호출 줄 세우기: 동시에 여러 요청이 몰려도 순서대로,
// 최소 간격(모의 0.55초 / 실전 0.06초)을 지키며 나가게 한다.
// 이러면 증권사 초당 한도(모의 2건/실전 20건)에 애초에 걸리지 않는다.
let queueTail = Promise.resolve();
let lastCallAt = 0;

function waitForTurn(minGapMs) {
  const turn = queueTail.then(async () => {
    const wait = lastCallAt + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  });
  queueTail = turn.catch(() => {});
  return turn;
}

export async function kisRequest({ method = "GET", path, trId, params, body }) {
  const config = loadConfig();
  const token = await getAccessToken();

  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  for (let attempt = 0; ; attempt++) {
    await waitForTurn(config.mode === "paper" ? 550 : 60);
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: config.appKey,
        appsecret: config.appSecret,
        tr_id: trId,
        custtype: "P",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let data;
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (res.ok && data.rt_cd === "0") return data;

    // 초당 호출 한도 초과(EGW00201)는 일시적 오류 — 잠시 기다렸다가 재시도
    const rateLimited =
      data.msg_cd === "EGW00201" || (data.msg1 ?? "").includes("초당 거래건수");
    if (rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
      const waitMs = 1000 * (attempt + 1);
      console.log(`  (호출 한도 도달 — ${waitMs / 1000}초 쉬었다가 다시 시도합니다)`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(
      `KIS API 오류 [${trId}] HTTP ${res.status} rt_cd=${data.rt_cd ?? "?"} ${data.msg1 ?? ""}`.trim()
    );
  }
}

// 모의투자(paper)와 실전(real)은 같은 API라도 tr_id가 다르다.
// 실전 tr_id의 앞글자 T를 V로 바꾸면 모의투자 tr_id가 된다.
export function trIdFor(realTrId) {
  const config = loadConfig();
  return config.mode === "paper" ? "V" + realTrId.slice(1) : realTrId;
}
