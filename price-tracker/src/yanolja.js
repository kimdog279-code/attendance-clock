'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  walkJson,
  parseEmbeddedJson,
  domHeuristic,
  roomHeuristic,
  matchTarget,
  dedupe,
} = require('./extract');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 검색 URL 후보들.
 * 야놀자가 쿼리 파라미터 이름을 여러 번 바꿔 왔기 때문에 하나만 믿지 않고
 * 순서대로 시도하다가 결과가 나오는 것을 채택한다.
 */
function searchUrls({ keyword, checkin, checkout, adults, children }) {
  const kw = encodeURIComponent(keyword);
  const common = `adultCount=${adults}&childCount=${children}`;
  return [
    `https://www.yanolja.com/search/${kw}?keyword=${kw}&searchKeyword=${kw}&startDate=${checkin}&endDate=${checkout}&${common}`,
    `https://www.yanolja.com/search/${kw}?keyword=${kw}&checkInDate=${checkin}&checkOutDate=${checkout}&${common}`,
    `https://www.yanolja.com/search?keyword=${kw}&startDate=${checkin}&endDate=${checkout}&${common}`,
    `https://nol.yanolja.com/search/${kw}?keyword=${kw}&startDate=${checkin}&endDate=${checkout}&${common}`,
  ];
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`날짜 형식이 잘못됐습니다: ${isoDate} (YYYY-MM-DD)`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Playwright 오류 메시지는 call log 까지 길게 딸려오므로 첫 줄만 쓴다. */
const firstLine = (msg) => String(msg || '').split('\n')[0].trim();

/** 지연 로딩된 카드까지 나오도록 천천히 스크롤한다. */
async function scrollToLoad(page, { rounds = 8, pause = 900 } = {}) {
  let lastHeight = 0;
  for (let i = 0; i < rounds; i++) {
    const height = await page.evaluate(() => {
      window.scrollBy(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });
    await sleep(pause);
    if (height === lastHeight && i > 1) break;
    lastHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** 인라인 <script> 안의 JSON 에서 숙소·가격을 긁는다. */
async function extractFromScripts(page) {
  const payloads = await page.evaluate(() => {
    const out = { next: null, scripts: [] };
    const nextEl = document.getElementById('__NEXT_DATA__');
    if (nextEl) out.next = nextEl.textContent;
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.length > 200 && t.length < 3000000 && /price|Price|원/.test(t)) out.scripts.push(t);
    }
    return out;
  });

  const items = [];
  if (payloads.next) {
    try {
      walkJson(JSON.parse(payloads.next), items);
    } catch {
      /* __NEXT_DATA__ 가 JSON 이 아니면 무시 */
    }
  }
  for (const text of payloads.scripts.slice(0, 40)) {
    for (const parsed of parseEmbeddedJson(text)) walkJson(parsed, items);
  }
  return items;
}

/**
 * URL 파라미터가 안 먹었을 때를 대비한 UI 조작 경로.
 * 홈에서 검색어를 직접 입력해 결과 페이지로 진입한다.
 */
async function searchViaUi(page, keyword, log) {
  log('URL 파라미터 방식 실패 → 홈에서 직접 검색을 시도합니다.');
  try {
    await page.goto('https://www.yanolja.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    log(`  홈 접속 실패: ${firstLine(err.message)}`);
    return false;
  }
  await sleep(2500);

  const boxSelectors = [
    "input[placeholder*='검색']",
    "input[type='search']",
    "[role='searchbox']",
    "[class*='search'] input",
  ];
  for (const sel of boxSelectors) {
    const box = page.locator(sel).first();
    if (!(await box.count().catch(() => 0))) continue;
    try {
      await box.click({ timeout: 5000 });
      await box.fill(keyword, { timeout: 5000 });
      await sleep(1200);
      await box.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await sleep(3000);
      return true;
    } catch {
      continue;
    }
  }

  // 검색창을 여는 버튼이 따로 있는 레이아웃 대응
  const opener = page.getByText('검색', { exact: false }).first();
  if (await opener.count().catch(() => 0)) {
    await opener.click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
    const box = page.locator("input").first();
    if (await box.count().catch(() => 0)) {
      await box.fill(keyword, { timeout: 5000 }).catch(() => {});
      await box.press('Enter').catch(() => {});
      await sleep(3000);
      return true;
    }
  }
  return false;
}

/** 한 검색어에 대해 URL 후보 → UI 폴백 순으로 결과 목록을 가져온다. */
async function runSearch(page, query, { debug, debugDir, log }) {
  for (const url of searchUrls(query)) {
    log(`접속: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err) {
      log(`  이동 실패: ${firstLine(err.message)}`);
      continue;
    }
    await sleep(3500);
    await scrollToLoad(page);

    const fromDom = await page.evaluate(domHeuristic).catch(() => []);
    const fromScripts = await extractFromScripts(page).catch(() => []);
    const merged = dedupe([...fromDom, ...fromScripts]);
    log(`  추출: DOM ${fromDom.length}건 / JSON ${fromScripts.length}건 → 중복 제거 후 ${merged.length}건`);

    if (debug) await saveDebug(page, debugDir, `search-${new URL(url).hostname}`, log);
    if (merged.length >= 3) return { items: merged, url };
  }

  const ok = await searchViaUi(page, query.keyword, log);
  if (ok) {
    await scrollToLoad(page);
    const fromDom = await page.evaluate(domHeuristic).catch(() => []);
    const fromScripts = await extractFromScripts(page).catch(() => []);
    const items = dedupe([...fromDom, ...fromScripts]);
    log(`  UI 검색 결과: ${items.length}건`);
    log('※ UI 경로로 들어오면 날짜·인원이 기본값일 수 있으니 화면에서 확인하세요.');
    if (debug) await saveDebug(page, debugDir, 'search-ui', log);
    if (items.length) return { items, url: page.url() };
  }
  return { items: [], url: null };
}

/** 목표 숙소 상세 페이지에서 객실별 가격을 수집한다. 실패해도 전체 실행은 계속된다. */
async function collectRooms(page, href, query, { debug, debugDir, log }) {
  let url;
  try {
    url = new URL(href, 'https://www.yanolja.com');
  } catch {
    log(`  상세 링크를 해석할 수 없습니다: ${href}`);
    return { url: null, rooms: [] };
  }
  // 검색 조건이 상세 페이지에도 적용되도록 파라미터를 실어 보낸다.
  url.searchParams.set('startDate', query.checkin);
  url.searchParams.set('endDate', query.checkout);
  url.searchParams.set('adultCount', String(query.adults));
  url.searchParams.set('childCount', String(query.children));

  log(`상세 페이지 접속: ${url.href}`);
  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    log(`  상세 페이지 이동 실패: ${firstLine(err.message)}`);
    return { url: url.href, rooms: [] };
  }
  await sleep(3500);
  await scrollToLoad(page, { rounds: 5 });

  const fromDom = await page.evaluate(roomHeuristic).catch(() => []);
  const fromScripts = await extractFromScripts(page).catch(() => []);
  const rooms = dedupe([...fromDom, ...fromScripts]);
  log(`  객실 추출: ${rooms.length}건`);
  if (debug) await saveDebug(page, debugDir, 'detail', log);

  return { url: url.href, rooms };
}

async function saveDebug(page, dir, tag, log) {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, tag);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    fs.writeFileSync(`${base}.html`, await page.content(), 'utf8');
    log(`디버그 저장: ${base}.png / ${base}.html`);
  } catch (err) {
    log(`디버그 저장 실패: ${err.message}`);
  }
}

/**
 * 야놀자 검색 결과에서 숙소별 가격을 수집한다.
 * @returns {Promise<{query: object, collectedAt: string, url: string|null, items: object[]}>}
 */
async function collect(options) {
  const {
    keyword,
    target = null,
    checkin,
    nights = 1,
    adults = 2,
    children = 0,
    rooms: wantRooms = true,
    headless = true,
    debug = false,
    debugDir = path.join(__dirname, '..', 'debug'),
    log = console.log,
  } = options;

  const checkout = addDays(checkin, nights);
  const query = { keyword, target, checkin, checkout, nights, adults, children };

  const browser = await chromium.launch({
    headless,
    // 크로미움을 따로 받을 수 없는 환경에서는 CHROMIUM_PATH 로 기존 바이너리를 지정한다.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--disable-blink-features=AutomationControlled', '--lang=ko-KR'],
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 960 },
  });
  // 간단한 자동화 탐지 회피(navigator.webdriver 숨김)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const ctx = { debug, debugDir, log };
  let items = [];
  let usedUrl = null;
  let matched = null;
  let candidates = [];
  let detailUrl = null;
  let rooms = [];

  try {
    ({ items, url: usedUrl } = await runSearch(page, query, ctx));

    if (target && items.length) {
      ({ match: matched, candidates } = matchTarget(items, target));
      log(matched ? `목표 숙소 발견: ${matched.name}` : `목표 숙소("${target}")를 목록에서 찾지 못했습니다.`);
    }

    // 지역 검색 목록에 없으면(페이지네이션·정렬 때문에 누락 가능) 호텔명으로 다시 검색한다.
    if (target && !matched) {
      log(`"${target}" 로 직접 재검색합니다.`);
      const retry = await runSearch(page, { ...query, keyword: target }, ctx);
      if (retry.items.length) {
        const m = matchTarget(retry.items, target);
        if (m.match) {
          matched = m.match;
          usedUrl = retry.url;
          items = dedupe([...items, ...retry.items]);
          log(`목표 숙소 발견(재검색): ${matched.name}`);
        } else if (!candidates.length) {
          candidates = m.candidates;
        }
      }
    }

    if (matched && wantRooms && matched.url) {
      ({ url: detailUrl, rooms } = await collectRooms(page, matched.url, query, ctx));
    } else if (matched && wantRooms && !matched.url) {
      log('  상세 링크를 찾지 못해 객실별 가격은 건너뜁니다(목록 가격만 수집).');
    }

    if (!items.length && !debug) await saveDebug(page, debugDir, 'failed', log);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return {
    query,
    collectedAt: new Date().toISOString(),
    url: usedUrl,
    items,
    target: matched,
    targetCandidates: candidates,
    detailUrl,
    rooms,
  };
}

module.exports = { collect, addDays, searchUrls };
