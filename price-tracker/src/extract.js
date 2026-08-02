'use strict';

// 야놀자 검색 결과에서 "숙소명 + 가격"을 뽑아내는 추출기 모음.
//
// 사이트 마크업은 자주 바뀌므로 하나의 CSS 셀렉터에 의존하지 않는다.
// 서로 독립적인 3가지 방식으로 뽑은 뒤 합쳐서 중복을 제거한다.
//   1) __NEXT_DATA__ 등 인라인 JSON 을 트리 순회
//   2) Next.js app-router 의 flight 페이로드(self.__next_f) 안의 JSON 조각
//   3) 화면에 그려진 카드의 텍스트를 휴리스틱으로 파싱
// 1·2 가 실패해도 3 이 남으므로 스키마가 바뀌어도 최소한의 수집은 유지된다.

const MIN_PRICE = 5000;        // 이보다 싸면 가격이 아니라 포인트·할인율일 확률이 높다
const MAX_PRICE = 5000000;

/** 객체 트리를 순회하며 "이름 + 가격" 을 가진 노드를 모은다. */
function walkJson(root, out, seen = new WeakSet(), depth = 0) {
  if (!root || typeof root !== 'object' || depth > 12) return out;
  if (seen.has(root)) return out;
  seen.add(root);

  if (Array.isArray(root)) {
    for (const item of root) walkJson(item, out, seen, depth + 1);
    return out;
  }

  const name = pickName(root);
  if (name) {
    const prices = pickPrices(root);
    if (prices.length) {
      out.push({
        name,
        priceMin: Math.min(...prices),
        priceMax: Math.max(...prices),
        prices,
        source: 'json',
        raw: compactRaw(root),
      });
    }
  }

  for (const value of Object.values(root)) walkJson(value, out, seen, depth + 1);
  return out;
}

const NAME_KEYS = ['name', 'placeName', 'hotelName', 'title', 'displayName', 'lodgeName'];
const PRICE_KEY_RE = /(price|amount|fee|cost)/i;
const PRICE_EXCLUDE_RE = /(rate|percent|discountRate|point|mileage|coupon)/i;

function pickName(obj) {
  for (const key of NAME_KEYS) {
    const v = obj[key];
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.length >= 2 && s.length <= 80) return s;
    }
  }
  return null;
}

function pickPrices(obj) {
  const found = [];
  for (const [key, value] of Object.entries(obj)) {
    if (!PRICE_KEY_RE.test(key) || PRICE_EXCLUDE_RE.test(key)) continue;
    for (const n of numbersIn(value)) {
      if (n >= MIN_PRICE && n <= MAX_PRICE) found.push(n);
    }
  }
  return [...new Set(found)];
}

/** 숫자 자체 / 숫자 문자열 / 한 겹 중첩된 객체까지만 본다. */
function numbersIn(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return [Math.round(value)];
  if (typeof value === 'string') {
    const n = Number(value.replace(/[,\s원]/g, ''));
    return Number.isFinite(n) && n > 0 ? [Math.round(n)] : [];
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = [];
    for (const [k, v] of Object.entries(value)) {
      if (PRICE_EXCLUDE_RE.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) out.push(Math.round(v));
      else if (typeof v === 'string') {
        const n = Number(v.replace(/[,\s원]/g, ''));
        if (Number.isFinite(n) && n > 0) out.push(Math.round(n));
      }
    }
    return out;
  }
  return [];
}

function compactRaw(obj) {
  const keep = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) keep[k] = v;
  }
  return keep;
}

/** 문자열 안에 박힌 JSON 조각들을 최대한 파싱한다(flight 페이로드용). */
function parseEmbeddedJson(text) {
  const results = [];
  const starts = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') starts.push(i);
  }
  // 후보가 너무 많으면 앞쪽 일부만 시도한다(파싱 비용 방어).
  for (const start of starts.slice(0, 4000)) {
    const slice = text.slice(start, start + 400000);
    const parsed = tryParsePrefix(slice);
    if (parsed) results.push(parsed);
  }
  return results;
}

/** slice 앞부분에서 균형 잡힌 JSON 을 하나 잘라내 파싱 시도. */
function tryParsePrefix(slice) {
  const open = slice[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        if (i < 40) return null; // 너무 짧으면 의미 없음
        try {
          return JSON.parse(slice.slice(0, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 페이지 안(브라우저 컨텍스트)에서 실행되는 DOM 휴리스틱.
 * 함수 본문이 문자열로 직렬화되어 전달되므로 외부 변수를 참조하면 안 된다.
 */
function domHeuristic() {
  const MIN = 5000;
  const MAX = 5000000;
  const PRICE_RE = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{5,7})\s*원/g;

  const selectors = [
    "a[href*='/hotel/']",
    "a[href*='/stay/']",
    "a[href*='/pension/']",
    "a[href*='/motel/']",
    "[data-testid*='card']",
    "[class*='SearchResult'] li",
    "[class*='searchResult'] li",
    "[class*='card'] a",
    'li',
  ];

  const nodes = new Set();
  for (const sel of selectors) {
    let found = [];
    try {
      found = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of found) nodes.add(el);
    if (nodes.size > 4000) break;
  }

  const noise =
    /^(예약|바로예약|대실|숙박|리뷰|후기|쿠폰|할인|무료취소|남은객실|객실|평점|광고|AD|더보기|지도|찜|사진|이미지)/;

  const items = [];
  for (const el of nodes) {
    const text = (el.innerText || '').trim();
    if (!text || text.length > 700) continue;

    const prices = [];
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(text)) !== null) {
      const n = Number(m[1].replace(/,/g, ''));
      if (n >= MIN && n <= MAX) prices.push(n);
    }
    if (!prices.length) continue;

    // 자식 하나가 내용을 거의 그대로 담고 있으면 이 노드는 래퍼일 뿐 → 건너뛴다.
    // (li > a 처럼 텍스트가 완전히 같은 경우를 포함)
    let wrapper = false;
    for (const child of el.children) {
      const ct = (child.innerText || '').trim();
      if (ct && /[0-9,]{4,}\s*원/.test(ct) && ct.length >= text.length * 0.9) wrapper = true;
    }
    if (wrapper) continue;

    const lines = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    // 숙소명은 전용 엘리먼트에서 먼저 찾는다. 실패하면 텍스트 줄 휴리스틱으로 폴백.
    let name = null;
    let nameEl = null;
    try {
      nameEl = el.querySelector("[class*='name'],[class*='Name'],[class*='title'],[class*='Title'],h2,h3,h4");
    } catch {
      nameEl = null;
    }
    if (nameEl) {
      const t = ((nameEl.innerText || '').trim().split('\n')[0] || '').trim();
      if (t.length >= 2 && t.length <= 60 && !/원$/.test(t) && !noise.test(t)) name = t;
    }
    if (!name) {
      name = lines.find(
        (l) => l.length >= 2 && l.length <= 60 && !/원$/.test(l) && !noise.test(l) && !/^[0-9.,%]+$/.test(l),
      );
    }
    if (!name) continue;

    const anchor = el.tagName === 'A' ? el : el.querySelector('a');
    const link = anchor ? anchor.getAttribute('href') : null;

    items.push({
      name,
      priceMin: Math.min.apply(null, prices),
      priceMax: Math.max.apply(null, prices),
      prices: Array.from(new Set(prices)),
      url: link || null,
      source: 'dom',
      raw: { text: text.slice(0, 300) },
    });
  }
  return items;
}

/**
 * 상세 페이지의 객실별 가격을 뽑는 휴리스틱.
 * domHeuristic 과 마찬가지로 브라우저 컨텍스트에서 실행되므로 외부 참조 금지.
 */
function roomHeuristic() {
  const MIN = 5000;
  const MAX = 5000000;
  const PRICE_RE = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{5,7})\s*원/g;

  const selectors = [
    "[class*='room'] li",
    "[class*='Room'] li",
    "[data-testid*='room']",
    "[class*='RoomItem']",
    "[class*='roomItem']",
    'article',
    'li',
  ];

  const nodes = new Set();
  for (const sel of selectors) {
    let found = [];
    try {
      found = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of found) nodes.add(el);
    if (nodes.size > 3000) break;
  }

  // 객실명 후보에서 걸러낼 라벨. 대실/숙박은 상품 구분이라 남긴다.
  const noise = /^(예약|바로예약|리뷰|후기|쿠폰|할인|무료취소|남은객실|평점|광고|AD|더보기|지도|찜|사진|전체)/;

  const items = [];
  for (const el of nodes) {
    const text = (el.innerText || '').trim();
    if (!text || text.length > 800) continue;

    const prices = [];
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(text)) !== null) {
      const n = Number(m[1].replace(/,/g, ''));
      if (n >= MIN && n <= MAX) prices.push(n);
    }
    if (!prices.length) continue;

    // 자식이 같은 내용을 거의 그대로 담고 있으면 이 노드는 래퍼다.
    let wrapper = false;
    for (const child of el.children) {
      const ct = (child.innerText || '').trim();
      if (ct && /[0-9,]{4,}\s*원/.test(ct) && ct.length > text.length * 0.9) wrapper = true;
    }
    if (wrapper) continue;

    const lines = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    let name = null;
    let nameEl = null;
    try {
      nameEl = el.querySelector("[class*='name'],[class*='Name'],[class*='title'],[class*='Title'],h3,h4");
    } catch {
      nameEl = null;
    }
    if (nameEl) {
      const t = ((nameEl.innerText || '').trim().split('\n')[0] || '').trim();
      if (t.length >= 2 && t.length <= 60 && !/원$/.test(t) && !noise.test(t)) name = t;
    }
    if (!name) {
      name = lines.find(
        (l) => l.length >= 2 && l.length <= 60 && !/원$/.test(l) && !noise.test(l) && !/^[0-9.,%]+$/.test(l),
      );
    }
    if (!name) continue;

    items.push({
      name,
      priceMin: Math.min.apply(null, prices),
      priceMax: Math.max.apply(null, prices),
      prices: Array.from(new Set(prices)),
      stayType: /대실/.test(text) ? '대실' : /숙박/.test(text) ? '숙박' : null,
      source: 'dom',
      raw: { text: text.slice(0, 300) },
    });
  }
  return items;
}

/** 공백·괄호·특수문자를 지운 비교용 이름. "속초 굿모닝 호텔" == "속초굿모닝호텔" */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·・.,()[\]{}'"!&/]/g, '');
}

/**
 * 수집 목록에서 목표 숙소를 찾는다.
 * 완전일치 → 부분 포함 → 핵심 토큰(호텔/모텔/펜션 등 접미어 제거) 포함 순으로 느슨해진다.
 * @returns {{match: object|null, candidates: object[]}}
 */
function matchTarget(items, target) {
  const want = normalizeName(target);
  if (!want) return { match: null, candidates: [] };

  const scored = items.map((item) => {
    const got = normalizeName(item.name);
    let score = 0;
    if (got === want) score = 100;
    else if (got.includes(want) || want.includes(got)) score = 80;
    else {
      const core = want.replace(/(호텔|모텔|펜션|리조트|게스트하우스|콘도)$/, '');
      if (core.length >= 2 && (got.includes(core) || core.includes(got))) score = 60;
      else {
        // 2글자 단위로 쪼개 겹치는 비율을 본다(오타·띄어쓰기 변형 대응)
        const grams = new Set();
        for (let i = 0; i < want.length - 1; i++) grams.add(want.slice(i, i + 2));
        let hit = 0;
        for (const g of grams) if (got.includes(g)) hit++;
        score = grams.size ? Math.round((hit / grams.size) * 50) : 0;
      }
    }
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return {
    match: best && best.score >= 60 ? { ...best.item, matchScore: best.score } : null,
    candidates: scored
      .filter((s) => s.score >= 20)
      .slice(0, 5)
      .map((s) => ({ name: s.item.name, priceMin: s.item.priceMin, score: s.score })),
  };
}

/** 같은 숙소가 여러 추출기에서 중복으로 나오므로 이름 기준으로 합친다. */
function dedupe(items) {
  const byName = new Map();
  for (const item of items) {
    if (!item || !item.name) continue;
    // 같은 객실명이라도 대실/숙박은 다른 상품이므로 따로 센다.
    const key = `${normalizeName(item.name)}|${item.stayType || ''}`;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, { ...item, prices: [...new Set(item.prices)].sort((a, b) => a - b) });
      continue;
    }
    const merged = [...new Set([...prev.prices, ...item.prices])].sort((a, b) => a - b);
    byName.set(key, {
      ...prev,
      url: prev.url || item.url || null,
      prices: merged,
      priceMin: merged[0],
      priceMax: merged[merged.length - 1],
      source: prev.source === item.source ? prev.source : `${prev.source}+${item.source}`,
    });
  }
  return [...byName.values()].sort((a, b) => a.priceMin - b.priceMin);
}

module.exports = {
  walkJson,
  parseEmbeddedJson,
  domHeuristic,
  roomHeuristic,
  normalizeName,
  matchTarget,
  dedupe,
  MIN_PRICE,
  MAX_PRICE,
};
