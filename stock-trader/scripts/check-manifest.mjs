// 릴리스 전 검사: 자동 업데이트 배달 목록(files.json)에 누락된 파일이 없는지 확인.
// 사용법: node scripts/check-manifest.mjs  (개발용 — 사용자 배포 대상 아님)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

const listed = new Set(JSON.parse(fs.readFileSync("files.json", "utf8")));
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]
  );
const actual = [
  ...walk("src"),
  ...walk("ui"),
  "package.json",
  "시작하기.bat",
  "바로가기만들기.bat",
  "README.md",
  "config.example.json",
];

const missing = actual.filter((f) => !listed.has(f));
const stale = [...listed].filter((f) => f !== "files.json" && !fs.existsSync(f));

if (missing.length) console.error("❌ files.json에 누락:", missing.join(", "));
if (stale.length) console.error("⚠ files.json에 있지만 실재하지 않음:", stale.join(", "));
if (missing.length) process.exit(1);
console.log(`✅ 배달 목록 정상 (${actual.length}개 파일 확인)`);
