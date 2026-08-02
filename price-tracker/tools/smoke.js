'use strict';

// 오프라인 스모크 테스트.
// 야놀자에 접속하지 않고 tools/*.html 픽스처로 추출·매칭 로직을 확인한다.
//
//   node tools/smoke.js

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { domHeuristic, roomHeuristic, matchTarget, dedupe, walkJson } = require('../src/extract');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage();

  // --- 검색 목록 ---
  await page.goto(pathToFileURL(path.join(__dirname, 'fixture.html')).href);
  const listDom = await page.evaluate(domHeuristic);
  const nextData = JSON.parse(await page.locator('#__NEXT_DATA__').textContent());
  const listJson = walkJson(nextData, []);
  const items = dedupe([...listDom, ...listJson]);

  check('검색 목록 DOM 추출', listDom.length >= 4, `${listDom.length}건`);
  check('검색 목록 JSON 추출', listJson.length === 2, `${listJson.length}건 (할인율만 있는 항목은 제외돼야 함)`);
  check('중복 제거 후 숙소 수', items.length === 4, `${items.length}건`);

  const oceanview = items.find((i) => i.name.includes('오션뷰'));
  check('DOM+JSON 병합', oceanview && oceanview.source.includes('+'), oceanview && oceanview.source);

  // --- 목표 숙소 매칭 ---
  const { match, candidates } = matchTarget(items, '속초굿모닝호텔');
  check('띄어쓰기 다른 이름 매칭', Boolean(match), match && `${match.name} (일치도 ${match.matchScore})`);
  check('할인 전/후 가격 모두 수집', match && match.priceMin === 98000 && match.priceMax === 150000,
    match && `${match.priceMin} ~ ${match.priceMax}`);
  check('상세 링크 확보', Boolean(match && match.url), match && match.url);

  const miss = matchTarget(items, '존재하지않는호텔이름');
  check('없는 숙소는 null', miss.match === null);
  check('후보 목록 제공', Array.isArray(miss.candidates));
  check('후보 개수 제한', candidates.length <= 5, `${candidates.length}건`);

  // --- 상세(객실) ---
  await page.goto(pathToFileURL(path.join(__dirname, 'fixture-detail.html')).href);
  const rooms = dedupe(await page.evaluate(roomHeuristic));
  check('객실 추출', rooms.length >= 2, `${rooms.length}건: ${rooms.map((r) => r.name).join(', ')}`);

  const deluxe = rooms.find((r) => r.name.includes('디럭스'));
  check('객실 가격 파싱', deluxe && deluxe.priceMin === 145000, deluxe && String(deluxe.priceMin));
  check('숙박/대실 구분', rooms.some((r) => r.stayType === '숙박'), rooms.map((r) => r.stayType).join('/'));

  await browser.close();

  console.log(failures ? `\n실패 ${failures}건` : '\n전부 통과');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
