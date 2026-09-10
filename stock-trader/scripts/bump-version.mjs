// 버전 올리기 — 현재 값을 읽어서 갱신하므로 '예상 값 불일치로 조용히 실패'가 없다.
// 사용법: node scripts/bump-version.mjs 0.14.2   (또는 인자 없이 = patch +1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
const before = pkg.version;

let next = process.argv[2];
if (!next) {
  const [a, b, c] = before.split(".").map(Number);
  next = `${a}.${b}.${c + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`잘못된 버전 형식: ${next}`);
  process.exit(1);
}
const cmp = (x, y) => {
  const p = x.split(".").map(Number), q = y.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] - q[i];
  return 0;
};
if (cmp(next, before) <= 0) {
  console.error(`버전이 올라가지 않습니다: ${before} → ${next}`);
  process.exit(1);
}

pkg.version = next;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
console.log(`✅ 버전 ${before} → ${next}`);
