// 접근토큰 발급·캐시.
// KIS 토큰은 24시간 유효하고 발급 호출에 분당 제한이 있으므로
// 파일(.token-cache.json)에 캐시해서 재사용한다.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

const EXPIRY_BUFFER_MS = 60 * 60 * 1000; // 만료 1시간 전부터는 재발급

function cachePath() {
  return path.join(loadConfig().root, ".token-cache.json");
}

function readCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    const config = loadConfig();
    if (cache.mode !== config.mode || cache.appKey !== config.appKey) return null;
    if (Date.now() > cache.expiresAt - EXPIRY_BUFFER_MS) return null;
    return cache.accessToken;
  } catch {
    return null;
  }
}

export async function getAccessToken() {
  const cachedToken = readCache();
  if (cachedToken) return cachedToken;

  const config = loadConfig();
  const res = await fetch(`${config.baseUrl}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: config.appKey,
      appsecret: config.appSecret,
    }),
  });

  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`토큰 발급 실패 (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }

  fs.writeFileSync(
    cachePath(),
    JSON.stringify({
      mode: config.mode,
      appKey: config.appKey,
      accessToken: body.access_token,
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    })
  );
  return body.access_token;
}
