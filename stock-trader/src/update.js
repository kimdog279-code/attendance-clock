// 자동 업데이트.
// 시작할 때 깃허브의 최신 package.json 버전과 비교해서, 새 버전이 있으면
// files.json 목록의 파일들을 내려받아 교체한다.
// config.json(키)·data/(수집 데이터)는 목록에 없으므로 절대 건드리지 않는다.
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./config.js";

const BASE =
  process.env.UPDATE_BASE_URL ??
  "https://raw.githubusercontent.com/kimdog279-code/attendance-clock/claude/stock-trading-program-plan-ppt94p/stock-trader/";

function localVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

function isNewer(remote, local) {
  const r = String(remote).split(".").map(Number);
  const l = String(local).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

// 상세 확인: 현재/최신 버전과 실패 사유까지 돌려준다.
// ?t=시각 파라미터로 CDN 캐시를 우회해 항상 방금 올라간 버전을 본다.
export async function updateInfo() {
  const current = localVersion();
  try {
    const res = await fetch(`${BASE}package.json?t=${Date.now()}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { current, error: `서버 응답 HTTP ${res.status}` };
    const remote = (await res.json()).version;
    return { current, remote, hasUpdate: isNewer(remote, current) };
  } catch (err) {
    return { current, error: err.message };
  }
}

// 새 버전이 있으면 버전 문자열, 없거나 확인 실패면 null (실패해도 프로그램은 정상 동작)
export async function checkForUpdate() {
  const info = await updateInfo();
  return info.hasUpdate ? info.remote : null;
}

export async function applyUpdate() {
  const buster = `?t=${Date.now()}`; // CDN 캐시 우회 — 항상 최신 파일을 받는다
  const res = await fetch(BASE + "files.json" + buster, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("업데이트 파일 목록을 가져오지 못했습니다");
  const files = await res.json();

  const root = projectRoot();
  let updated = 0;
  for (const rel of files) {
    if (typeof rel !== "string" || rel.includes("..") || path.isAbsolute(rel)) continue;

    const url = BASE + rel.split("/").map(encodeURIComponent).join("/") + buster;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${rel} 다운로드 실패 (HTTP ${r.status})`);
    const content = Buffer.from(await r.arrayBuffer());

    const dest = path.join(root, rel);
    // 내용이 같은 파일은 건너뛴다 (실행 중인 시작하기.bat을 불필요하게 덮어쓰지 않도록)
    try {
      if (fs.readFileSync(dest).equals(content)) continue;
    } catch {}
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    updated++;
  }
  return updated;
}
