'use strict';

// ===========================================================================
//  급여 계산 엔진 (순수 함수, electron 비의존 — main.js·테스트 공용)
//
//  검증된 2026 한국 노동법(5인 이상) 규칙
//   - 연장: 1일 8h 초과 또는 주 40h 초과 → 통상시급 ×1.5 (중복 안 되게 분리 집계)
//   - 야간: 22:00~06:00 → ×0.5 가산(가산분만, 연장·휴일과 별개로 합산)
//   - 휴일: 8h 이내 ×1.5, 8h 초과 ×2.0
//   - 휴게: 일 8h↑ 직원 표준휴게, 4~8h 30분 무급공제
//   - 주휴(시급제만): 1주 소정 15h↑ + 개근 → 1일분 유급. 지각·조퇴는 개근 유지, 결근만 박탈
//   - 통상시급 = 월급 ÷ 209 (월급제) / 계약시급 (시급제). 줄마다 ROUND(,0) 후 합산
//
//  점각앱의 책임은 "시간·일수 집계 + 참고금액"이며, 확정 급여(공제·4대보험·세금)는
//  운영관리/대행사가 처리. 엑셀로 넘기는 핵심값은 연장/야간/휴일 '시간'.
// ===========================================================================

const NIGHT_START_MIN = 22 * 60; // 22:00
const NIGHT_END_MIN = 6 * 60;    // 06:00
const DAY_MS = 86400000;

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateAtTime(dateStr, hhmm) {
  // dateStr 'YYYY-MM-DD', hhmm 'HH:MM' (로컬) → epoch ms
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mi] = String(hhmm || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mi || 0, 0).getTime();
}

// [startTs,endTs] 와 야간시간대(매일 22:00~익일 06:00)의 교집합(분)
function nightMinutes(startTs, endTs) {
  if (!startTs || !endTs || endTs <= startTs) return 0;
  let total = 0;
  const base = new Date(startTs); base.setHours(0, 0, 0, 0);
  for (let d = base.getTime() - DAY_MS; d <= endTs; d += DAY_MS) {
    const ns = d + NIGHT_START_MIN * 60000;       // 그날 22:00
    const ne = d + DAY_MS + NIGHT_END_MIN * 60000; // 익일 06:00
    const lo = Math.max(startTs, ns), hi = Math.min(endTs, ne);
    if (hi > lo) total += hi - lo;
  }
  return Math.round(total / 60000);
}

// 무급 휴게 공제(분): 8h↑ 표준휴게, 4~8h 30분
function breakForGross(grossMin, stdBreak) {
  if (grossMin >= 480) return stdBreak == null ? 60 : stdBreak;
  if (grossMin >= 240) return Math.min(stdBreak == null ? 60 : stdBreak, 30);
  return 0;
}

// 점각들을 출근→퇴근 세션으로 짝짓기 (첫 in ~ 다음 out)
function pairSessions(punches) {
  const sorted = punches.slice().sort((a, b) => a.ts - b.ts);
  const sessions = [];
  let openIn = null;
  for (const p of sorted) {
    if (p.type === 'in') { if (openIn === null) openIn = p.ts; }
    else if (p.type === 'out') { if (openIn !== null) { sessions.push({ in: openIn, out: p.ts }); openIn = null; } }
  }
  return { sessions, unclosed: openIn };
}

// 하루치 집계
function dayLedger(sessions, emp, isHoliday, planned, grace) {
  let grossMin = 0, firstIn = null, lastOut = null, nightMin = 0;
  for (const s of sessions) {
    if (s.in && s.out && s.out > s.in) {
      grossMin += Math.round((s.out - s.in) / 60000);
      nightMin += nightMinutes(s.in, s.out);
      if (firstIn === null || s.in < firstIn) firstIn = s.in;
      if (lastOut === null || s.out > lastOut) lastOut = s.out;
    }
  }
  const breakMin = breakForGross(grossMin, emp.breakMinutes);
  const netMin = Math.max(grossMin - breakMin, 0);
  nightMin = Math.min(nightMin, netMin); // 야간은 순근로 한도

  let regularMin = 0, overtimeMin = 0, holidayMin = 0, holidayWithin = 0, holidayOver = 0;
  if (isHoliday) {
    holidayMin = netMin;
    holidayWithin = Math.min(netMin, 480);
    holidayOver = Math.max(netMin - 480, 0);
  } else {
    regularMin = Math.min(netMin, 480);
    overtimeMin = Math.max(netMin - 480, 0);
  }

  let lateMin = 0, earlyMin = 0;
  const gIn = (grace && grace.lateIn) || 0, gOut = (grace && grace.earlyOut) || 0;
  if (!isHoliday && planned && planned.start && firstIn && firstIn > planned.start + gIn * 60000) {
    lateMin = Math.round((firstIn - planned.start) / 60000);
  }
  if (!isHoliday && planned && planned.end && lastOut && lastOut < planned.end - gOut * 60000) {
    earlyMin = Math.round((planned.end - lastOut) / 60000);
  }
  return { grossMin, breakMin, netMin, regularMin, overtimeMin, nightMin, holidayMin, holidayWithin, holidayOver, lateMin, earlyMin, firstIn, lastOut, worked: grossMin > 0 };
}

// 그 주의 월요일 날짜키 (주 40h 판정 단위)
function weekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const off = (dt.getDay() + 6) % 7; // 월=0
  dt.setDate(dt.getDate() - off);
  return ymd(dt.getTime());
}

function monthDates(month) {
  // month 'YYYY-MM' → ['YYYY-MM-01', ...]
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= days; d++) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  return out;
}
function weekdayOf(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d).getDay(); } // 0=일

// 한 직원의 월 집계
//  emp: { payType, wage:{hourlyRate,monthlySalary,monthlyContractHours}, breakMinutes,
//         scheduleType('fixed'|'shift'), workDays:[0..6], shiftStart, shiftEnd, graceMinutes }
//  effPunches: 그 직원의 유효 점각 전체 [{type,ts,workDate}]
//  holidaysSet: Set('YYYY-MM-DD') 공휴일
//  settings: { standardWeeklyHours, grace, monthlyContractHours }
//  plan: 교대직 일별 예정시각 { 'YYYY-MM-DD': {start:'HH:MM', end:'HH:MM', overnight, kind} }
//        (운영관리 근무표 편성 가져오기). 고정직은 plan 무시(emp.shiftStart/End 사용).
function computeEmployeeMonth(emp, effPunches, holidaysSet, month, settings, plan) {
  settings = settings || {};
  const grace = emp.graceMinutes || settings.grace || { lateIn: 0, earlyOut: 0 };
  const isFixed = emp.scheduleType !== 'shift';
  const workDays = Array.isArray(emp.workDays) ? emp.workDays : [1, 2, 3, 4, 5];

  // 월 점각을 workDate별로 그룹
  const byDate = {};
  for (const p of effPunches) {
    const wd = p.workDate || ymd(p.ts);
    if (wd.slice(0, 7) !== month) continue;
    (byDate[wd] = byDate[wd] || []).push(p);
  }

  const days = [];
  const dailyByDate = {};
  for (const wd of Object.keys(byDate)) {
    const { sessions, unclosed } = pairSessions(byDate[wd]);
    const isPublicHol = holidaysSet && holidaysSet.has(wd);
    const isRestDay = isFixed && workDays.indexOf(weekdayOf(wd)) === -1; // 고정자의 비근무요일 근무 = 휴일근로
    const isHoliday = !!(isPublicHol || isRestDay);
    let planned = null;
    if (isFixed && !isHoliday && emp.shiftStart && emp.shiftEnd) {
      planned = { start: dateAtTime(wd, emp.shiftStart), end: dateAtTime(wd, emp.shiftEnd) };
      if (planned.end <= planned.start) planned.end += DAY_MS; // 자정 넘는 소정
    } else if (!isFixed && !isHoliday && plan && plan[wd] && plan[wd].kind === '근무' && plan[wd].start && plan[wd].end) {
      // 교대직: 그날 근무표 편성(예정 출퇴근)으로 지각/조퇴 판정
      planned = { start: dateAtTime(wd, plan[wd].start), end: dateAtTime(wd, plan[wd].end) };
      if (plan[wd].overnight || planned.end <= planned.start) planned.end += DAY_MS;
    }
    const L = dayLedger(sessions, emp, isHoliday, planned, grace);
    L.unclosed = !!unclosed;
    L.isHoliday = isHoliday;
    days.push({ workDate: wd, ledger: L });
    dailyByDate[wd] = L;
  }

  // 결근(고정자만): 소정근무일(근무요일·비공휴일)에 점각 없음
  let absentDays = 0;
  const absentList = [];
  if (isFixed) {
    for (const wd of monthDates(month)) {
      if (holidaysSet && holidaysSet.has(wd)) continue;
      if (workDays.indexOf(weekdayOf(wd)) === -1) continue;
      if (!byDate[wd] || !dailyByDate[wd] || !dailyByDate[wd].worked) { absentDays++; absentList.push(wd); }
    }
  } else if (plan) {
    // 교대직: 근무표 편성의 '근무'일인데 점각 없으면 결근
    for (const wd of monthDates(month)) {
      const pd = plan[wd];
      if (!pd || pd.kind !== '근무') continue;
      if (holidaysSet && holidaysSet.has(wd)) continue;
      if (!byDate[wd] || !dailyByDate[wd] || !dailyByDate[wd].worked) { absentDays++; absentList.push(wd); }
    }
  }

  // 합계 + 주 40h 초과 분리
  const s = { regularMin: 0, overtimeMin: 0, nightMin: 0, holidayWithinMin: 0, holidayOverMin: 0, holidayMin: 0, lateMin: 0, earlyMin: 0, lateDays: 0, earlyDays: 0, workedDays: 0, unclosedDays: 0 };
  const weekReg = {};
  for (const d of days) {
    const L = d.ledger;
    s.overtimeMin += L.overtimeMin;
    s.nightMin += L.nightMin;
    s.holidayMin += L.holidayMin;
    s.holidayWithinMin += L.holidayWithin;
    s.holidayOverMin += L.holidayOver;
    s.lateMin += L.lateMin; if (L.lateMin > 0) s.lateDays++;
    s.earlyMin += L.earlyMin; if (L.earlyMin > 0) s.earlyDays++;
    if (L.worked) s.workedDays++;
    if (L.unclosed) s.unclosedDays++;
    weekReg[weekKey(d.workDate)] = (weekReg[weekKey(d.workDate)] || 0) + L.regularMin;
  }
  const wkCap = (settings.standardWeeklyHours || 40) * 60;
  let regular = 0, weeklyOT = 0;
  for (const wk in weekReg) {
    const r = weekReg[wk];
    if (r > wkCap) { regular += wkCap; weeklyOT += r - wkCap; } else regular += r;
  }
  s.regularMin = regular;
  s.overtimeMin += weeklyOT;

  // 주휴(시급제 + 고정자): 주별 소정 15h↑ & 결근 0 → 1일분(소정시간/40*8 한도8h)
  let weeklyHolidayMin = 0;
  const absentSet = new Set(absentList);
  if (emp.payType !== 'monthly' && isFixed && emp.shiftStart && emp.shiftEnd) {
    const toMin = (t) => { const [hh, mi] = String(t).split(':').map(Number); return (hh || 0) * 60 + (mi || 0); };
    let schedGross = toMin(emp.shiftEnd) - toMin(emp.shiftStart);
    if (schedGross <= 0) schedGross += 1440; // 자정 넘는 소정
    const dailySched = Math.max(0, schedGross - breakForGross(schedGross, emp.breakMinutes));
    const weeks = {};
    for (const wd of monthDates(month)) {
      if (workDays.indexOf(weekdayOf(wd)) === -1) continue;
      if (holidaysSet && holidaysSet.has(wd)) continue;
      const wk = weekKey(wd);
      (weeks[wk] = weeks[wk] || { sched: 0, absent: false }).sched += dailySched;
      if (absentSet.has(wd)) weeks[wk].absent = true;
    }
    for (const wk in weeks) {
      const w = weeks[wk];
      if (!w.absent && w.sched >= 15 * 60) {
        weeklyHolidayMin += Math.min(Math.round((w.sched / (40 * 60)) * 8 * 60), 8 * 60);
      }
    }
  }

  const hourly = emp.payType === 'monthly'
    ? Math.round((emp.wage && emp.wage.monthlySalary || 0) / ((emp.wage && emp.wage.monthlyContractHours) || settings.monthlyContractHours || 209))
    : (emp.wage && emp.wage.hourlyRate || 0);
  const h = (min) => min / 60;
  const otPay = Math.round(h(s.overtimeMin) * hourly * 1.5);
  const nightPay = Math.round(h(s.nightMin) * hourly * 0.5);
  const holiPay = Math.round(h(s.holidayWithinMin) * hourly * 1.5 + h(s.holidayOverMin) * hourly * 2.0);
  const whPay = Math.round(h(weeklyHolidayMin) * hourly);

  return {
    empId: emp.id, extId: emp.extId || '', name: emp.name, region: emp.region || '', payType: emp.payType,
    hourly,
    regularMin: s.regularMin, overtimeMin: s.overtimeMin, nightMin: s.nightMin,
    holidayMin: s.holidayMin, holidayWithinMin: s.holidayWithinMin, holidayOverMin: s.holidayOverMin,
    weeklyHolidayMin,
    lateDays: s.lateDays, lateMin: s.lateMin, earlyDays: s.earlyDays, earlyMin: s.earlyMin,
    absentDays, workedDays: s.workedDays, unclosedDays: s.unclosedDays,
    otPay, nightPay, holiPay, weeklyHolidayPay: whPay,
    addTotal: otPay + nightPay + holiPay, // 가산수당 합(주휴 제외)
    absentList
  };
}

// ===========================================================================
//  손으로 만든 근무표(범례 + 격자) 직접 파싱 — 운영관리 '점각용 내보내기' 없이 원본 업로드 지원
//   입력: sheetGrids = { 시트명: [[cell,...],...] } (시각 셀은 Date 객체), fileName, employees[]
//   출력: { incoming[], months:Set, exts:Set, region, year, month, matched[], unmatched[] } | { error }
//   ※ 운영관리앱 parseWorkSchedule 이식. 시각은 Date.getHours/getMinutes(로컬)로 추출 = 엑셀 1899에폭 보정.
// ===========================================================================
const SCHED_TITLES = ['총지배인', '지배인', '부지배인', '매니저', '부매니저', '셰프', '쉐프', '조리장', '점장', '실장', '팀장', '부장', '차장', '과장', '대리', '주임', '반장', '사원', '이사', '대표'];
function splitNamePos(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  for (const t of SCHED_TITLES) { if (s.endsWith(t) && s.length > t.length) { const n = s.slice(0, s.length - t.length).trim(); if (n) return n; } }
  return s;
}
function parseTimeRangeS(raw) {
  const s = String(raw == null ? '' : raw).trim(); if (!s) return null;
  const overnightHint = /익일|익\s*일|다음\s*날/.test(s);
  const parts = s.split(/\s*[~\-～]\s*/); if (parts.length !== 2) return null;
  const toh = (t) => { const m = String(t).match(/(\d{1,2})(?::(\d{2}))?/); if (!m) return null; const h = Number(m[1]); const mn = m[2] != null ? Number(m[2]) : 0; if (h > 24 || mn > 59) return null; return h + mn / 60; };
  let a = toh(parts[0]); const b = toh(parts[1]); if (a == null || b == null) return null;
  if (a >= 24) a -= 24; const overnight = overnightHint || b < a; let dur = b - a; if (overnight) dur += 24; if (dur <= 0 || dur > 24) return null;
  const fmt = (x) => { const h = Math.floor(x % 24); const mn = Math.round((x - Math.floor(x)) * 60); return String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0'); };
  return { start: fmt(a), end: fmt(b), overnight };
}
function singleHM(v) {
  if (v instanceof Date) { const p = (x) => String(x).padStart(2, '0'); return p(v.getHours()) + ':' + p(v.getMinutes()); }
  const s = String(v == null ? '' : v).trim(); if (!s || /[~～]/.test(s) || /\d\s*-\s*\d/.test(s)) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/); if (!m) return null; const h = Number(m[1]); if (h > 24) return null;
  return String(h).padStart(2, '0') + ':' + m[2];
}
function buildLegendS(grid, headerRow) {
  const legend = {};
  for (let r = 0; r < headerRow; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const code = String(row[c] == null ? '' : row[c]).trim();
      if (!code || code.length > 2) continue;
      if (!/^[A-Za-z]\d?$|^휴$/.test(code)) continue;
      const nextRaw = String(row[c + 1] == null ? '' : row[c + 1]).trim();
      if (!nextRaw) continue;
      if (code === '휴') { legend['휴'] = { kind: 'off' }; continue; }
      const tr = parseTimeRangeS(nextRaw); if (tr) { legend[code] = { kind: 'work', start: tr.start, end: tr.end, overnight: tr.overnight }; continue; }
      const st = singleHM(row[c + 1]), en = singleHM(row[c + 2]);
      if (st && en) { const tr2 = parseTimeRangeS(st + '~' + en); if (tr2) { legend[code] = { kind: 'work', start: tr2.start, end: tr2.end, overnight: tr2.overnight }; continue; } }
      legend[code] = { kind: 'work' };
    }
  }
  return legend;
}
function resolveCellS(cell, legend, prevOvernight) {
  const v = String(cell == null ? '' : cell).trim();
  if (v === '') return prevOvernight ? { kind: 'cont' } : { kind: 'none' };
  if (v === '휴' || v === '휴무' || /^off$/i.test(v)) return { kind: 'off' };
  if (/^연(차)?$/.test(v) || /^반차$/.test(v)) return { kind: 'leave' };
  const L = legend[v];
  if (L) { if (L.start) return { kind: 'work', start: L.start, end: L.end, overnight: !!L.overnight }; return { kind: 'work' }; }
  const tr = parseTimeRangeS(v); if (tr) return { kind: 'work', start: tr.start, end: tr.end, overnight: tr.overnight };
  const adj = v.match(/^([A-Za-z]\d?)\s*[+\-]\s*\d+$/);
  if (adj && legend[adj[1]] && legend[adj[1]].start) { const L2 = legend[adj[1]]; return { kind: 'work', start: L2.start, end: L2.end, overnight: !!L2.overnight }; }
  if (v.length >= 3) return { kind: 'memo' };
  return { kind: 'unknown' };
}
function findGridSheetS(sheetGrids, preferMonth) {
  const cands = [];
  for (const nm of Object.keys(sheetGrids)) {
    const grid = sheetGrids[nm];
    const has = (labels) => grid.some((row) => Array.isArray(row) && row.some((v) => labels.indexOf(String(v == null ? '' : v).trim()) !== -1));
    if (has(['구분', '부서']) && has(['성명', '이름'])) { const sm = String(nm).match(/(\d{1,2})\s*월/); cands.push({ name: nm, grid, mon: sm ? Number(sm[1]) : null }); }
  }
  if (!cands.length) return null;
  if (preferMonth) { const p = cands.find((c) => c.mon === preferMonth); if (p) return p; }
  cands.sort((a, b) => (b.mon || 0) - (a.mon || 0)); return cands[0];
}
function parseGridSchedule(sheetGrids, fileName, employees) {
  const base = String(fileName || '');
  const fnMonthM = base.match(/(\d{1,2})\s*월/); const fnMonth = fnMonthM ? Number(fnMonthM[1]) : null;
  const fileRegion = /속초/.test(base) ? '속초' : (/평택/.test(base) ? '평택' : '');
  const found = findGridSheetS(sheetGrids, fnMonth);
  if (!found) return { error: '근무표 형식을 찾지 못했습니다(점각용 파일이거나, "구분/부서"+"성명/이름" 머리글이 있는 근무표여야 합니다).' };
  const grid = found.grid;
  let headerRow = -1, nameCol = -1; const dayCols = [];
  const idxOf = (row, labels) => row.findIndex((v) => labels.indexOf(String(v == null ? '' : v).trim()) !== -1);
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || []; const di = idxOf(row, ['구분', '부서']); const ni = idxOf(row, ['성명', '이름']);
    if (di !== -1 && ni !== -1) {
      headerRow = r; nameCol = ni;
      for (let c = ni + 1; c < row.length; c++) {
        const v = row[c]; const dnum = (typeof v === 'number') ? v : (/^\d{1,2}$/.test(String(v == null ? '' : v).trim()) ? Number(v) : null);
        if (dnum != null && dnum >= 1 && dnum <= 31) dayCols.push({ col: c, day: dnum }); else if (dayCols.length) break;
      }
      break;
    }
  }
  if (headerRow === -1 || !dayCols.length) return { error: '근무표의 일자 머리글(1~말일)을 찾지 못했습니다.' };
  let year = null, month = null;
  for (let r = 0; r <= headerRow && r < grid.length; r++) {
    const line = (grid[r] || []).map((v) => String(v == null ? '' : v)).join(' ');
    const ym = line.match(/(\d{4})\s*년\s*(\d{1,2})\s*월/); if (ym) { year = Number(ym[1]); month = Number(ym[2]); break; }
    if (month == null) { const mo = line.match(/(\d{1,2})\s*월/); if (mo) month = Number(mo[1]); }
  }
  if (month == null) { const sm = String(found.name).match(/(\d{1,2})\s*월/); if (sm) month = Number(sm[1]); }
  if (month == null && fnMonth) month = fnMonth;
  if (year == null) year = new Date().getFullYear();
  if (!month) return { error: '근무표의 월을 찾지 못했습니다(파일명/제목에 "6월"처럼 월 표기 필요).' };
  const dim = new Date(year, month, 0).getDate(); for (let i = dayCols.length - 1; i >= 0; i--) if (dayCols[i].day > dim) dayCols.splice(i, 1);
  const legend = buildLegendS(grid, headerRow);
  const byName = {};
  for (const e of employees) { if (!e || !e.name) continue; (byName[e.name] = byName[e.name] || []).push(e); }
  const pick = (nm) => { const list = byName[nm]; if (!list || !list.length) return null; if (list.length === 1) return list[0]; if (fileRegion) { const inR = list.find((e) => e.region === fileRegion); if (inR) return inR; } return list[0]; };
  const incoming = []; const months = new Set(); const exts = new Set(); const matched = new Set(); const unmatched = new Set();
  for (let r = headerRow + 2; r < grid.length; r++) {
    const row = grid[r] || [];
    const nameRaw = String(row[nameCol] == null ? '' : row[nameCol]).trim();
    if (!nameRaw || /^합\s*계$|^총\s*계$|^소\s*계$/.test(nameRaw)) continue;
    const nm = splitNamePos(nameRaw); const emp = pick(nm);
    if (!emp || !emp.extId) { unmatched.add(nm + (emp && !emp.extId ? '(직원ID없음)' : '')); continue; }
    if (emp.excludeFromSchedule) continue;
    matched.add(nm); let prevOv = false;
    for (const dc of dayCols) {
      const cell = resolveCellS(row[dc.col], legend, prevOv); prevOv = cell.overnight === true;
      let kind = '';
      if (cell.kind === 'work') kind = '근무'; else if (cell.kind === 'off' || cell.kind === 'none') kind = '휴무'; else if (cell.kind === 'leave') kind = '연차'; else if (cell.kind === 'cont') kind = '연속'; else continue;
      const date = year + '-' + String(month).padStart(2, '0') + '-' + String(dc.day).padStart(2, '0');
      incoming.push({ extId: emp.extId, date, name: emp.name, region: emp.region || fileRegion || '', start: cell.start || '', end: cell.end || '', overnight: cell.overnight === true, kind });
      months.add(date.slice(0, 7)); exts.add(emp.extId);
    }
  }
  return { incoming, months, exts, region: fileRegion, year, month, matched: Array.from(matched), unmatched: Array.from(unmatched) };
}

module.exports = {
  nightMinutes, breakForGross, pairSessions, dayLedger, weekKey, monthDates, weekdayOf,
  computeEmployeeMonth, ymd, dateAtTime, parseGridSchedule
};
