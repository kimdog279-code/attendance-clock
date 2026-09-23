// 자동매매 설정 기억하기.
// 프로그램을 껐다 켜도 "어떤 종목을, 어떤 전략으로, 연습인지 실행인지"가 남아야 한다.
// data/engine-setup.json 한 파일에 종목코드별로 저장한다.
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./config.js";

const file = () => path.join(projectRoot(), "data", "engine-setup.json");

export function loadSetups() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeSetups(all) {
  const dir = path.dirname(file());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

// 종목 하나의 설정을 갱신한다. patch에 준 값만 바뀐다.
export function saveSetup(code, patch) {
  const all = loadSetups();
  all[code] = { ...(all[code] ?? {}), ...patch, savedAt: new Date().toISOString() };
  writeSetups(all);
  return all[code];
}

// 지금 모드(모의/실전)에서 마지막에 돌고 있던 종목들
export function runningSetups(mode) {
  return Object.entries(loadSetups())
    .filter(([, s]) => s?.running === true && s?.mode === mode)
    .map(([code, s]) => ({ code, ...s }));
}
