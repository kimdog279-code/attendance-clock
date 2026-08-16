// KIS REST API 공통 호출 래퍼.
// 인증 헤더를 붙이고, 응답의 rt_cd를 검사해 실패 시 msg1을 담아 throw한다.
import { loadConfig } from "./config.js";
import { getAccessToken } from "./token.js";

export async function kisRequest({ method = "GET", path, trId, params, body }) {
  const config = loadConfig();
  const token = await getAccessToken();

  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

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

  const data = await res.json();
  if (!res.ok || data.rt_cd !== "0") {
    throw new Error(
      `KIS API 오류 [${trId}] HTTP ${res.status} rt_cd=${data.rt_cd ?? "?"} ${data.msg1 ?? ""}`.trim()
    );
  }
  return data;
}

// 모의투자(paper)와 실전(real)은 같은 API라도 tr_id가 다르다.
// 실전 tr_id의 앞글자 T를 V로 바꾸면 모의투자 tr_id가 된다.
export function trIdFor(realTrId) {
  const config = loadConfig();
  return config.mode === "paper" ? "V" + realTrId.slice(1) : realTrId;
}
