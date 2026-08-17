// 상장종목 마스터 (코드 ↔ 한글명).
// 한국투자증권이 공개 배포하는 종목 마스터 파일(kospi/kosdaq_code.mst.zip)을
// 내려받아 파싱하고 data/stockmaster.json에 캐시한다 (7일마다 갱신).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { projectRoot } from "./config.js";

const BASE = process.env.MASTER_BASE_URL ?? "https://new.real.download.dws.co.kr/common/master/";
// fixedTail: 각 줄 뒤쪽의 고정 길이 필드(바이트). 앞부분 = 단축코드9 + 표준코드12 + 한글명(가변)
const FILES = [
  { file: "kospi_code.mst.zip", fixedTail: 228, market: "KOSPI" },
  { file: "kosdaq_code.mst.zip", fixedTail: 222, market: "KOSDAQ" },
];
const WEEK_MS = 7 * 24 * 3600 * 1000;

const cachePath = () => path.join(projectRoot(), "data", "stockmaster.json");

// zip 안의 첫 번째 엔트리만 푼다 (마스터 zip은 단일 파일)
function unzipSingle(buf) {
  const sig = buf.indexOf(Buffer.from("PK\x03\x04", "binary"));
  if (sig < 0) throw new Error("zip 형식이 아닙니다");
  const flags = buf.readUInt16LE(sig + 6);
  const method = buf.readUInt16LE(sig + 8);
  const compSize = buf.readUInt32LE(sig + 18);
  const nameLen = buf.readUInt16LE(sig + 26);
  const extraLen = buf.readUInt16LE(sig + 28);
  const start = sig + 30 + nameLen + extraLen;
  if (method === 0) return buf.slice(start, start + compSize);
  if (compSize === 0 && flags & 8) return zlib.inflateRawSync(buf.slice(start));
  return zlib.inflateRawSync(buf.slice(start, start + compSize));
}

function parseMst(buffer, fixedTail, market) {
  const decoder = new TextDecoder("euc-kr");
  const stocks = [];
  let lineStart = 0;
  for (let i = 0; i <= buffer.length; i++) {
    if (i !== buffer.length && buffer[i] !== 0x0a) continue;
    let line = buffer.slice(lineStart, i);
    lineStart = i + 1;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.slice(0, -1);
    if (line.length <= fixedTail + 21) continue;
    const code = line.slice(0, 9).toString("ascii").trim();
    if (!/^\d{6}$/.test(code)) continue; // ELW·신주인수권 등 제외
    const name = decoder.decode(line.slice(21, line.length - fixedTail)).trim();
    if (name) stocks.push({ code, name, market });
  }
  return stocks;
}

let loading = null;

export async function ensureMaster(force = false) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (!force && Date.now() - cached.updatedAt < WEEK_MS && cached.stocks?.length > 0) {
      return cached.stocks;
    }
  } catch {}

  if (!loading) {
    loading = (async () => {
      const all = [];
      for (const { file, fixedTail, market } of FILES) {
        const res = await fetch(BASE + file, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`종목 목록 다운로드 실패 (${file}, HTTP ${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        all.push(...parseMst(unzipSingle(buf), fixedTail, market));
      }
      if (all.length < 100) throw new Error("종목 목록 파싱 결과가 비정상적으로 적습니다");
      fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
      fs.writeFileSync(cachePath(), JSON.stringify({ updatedAt: Date.now(), stocks: all }));
      return all;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

const norm = (s) => s.replaceAll(" ", "").toLowerCase();

export async function searchStocks(query) {
  const stocks = await ensureMaster();
  const q = norm(query);
  if (!q) return [];

  if (/^\d{1,6}$/.test(q)) {
    return stocks.filter((s) => s.code.startsWith(q)).slice(0, 15);
  }

  const scored = [];
  for (const s of stocks) {
    const n = norm(s.name);
    let rank;
    if (n === q) rank = 0;
    else if (n.startsWith(q)) rank = 1;
    else if (n.includes(q)) rank = 2;
    else continue;
    scored.push({ ...s, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name, "ko"));
  return scored.slice(0, 15).map(({ rank, ...s }) => s);
}
