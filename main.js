'use strict';

// ===========================================================================
//  출퇴근 점각 앱 — 메인 프로세스 (1단계: 점각 + 직원관리 + 백업)
//
//  설계 원칙
//   1) 점각 원본(punches)은 절대 수정/삭제하지 않는다(append-only). 보정은
//      corrections 에 "기록"으로만 쌓고, 유효값은 런타임에 합성한다.
//   2) punches / corrections / auditLog 는 해시체인으로 위변조를 탐지한다.
//   3) 파일 쓰기는 임시파일 → rename 으로 원자적으로 처리하고, 30분마다
//      자동 백업한다.
//   4) 시각 계산은 epoch(ms) 차이로 한다(자정/월말 오류 방지).
//
//  데이터 위치: app.getPath('userData')/data , 백업: .../backup
// ===========================================================================

const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const calc = require('./calc');

// 진단: 메인 프로세스 미처리 예외/거부를 파일에도 기록(파이프 유실 대비)
const CRASH_LOG = require('path').join(require('os').tmpdir(), 'attendance-crash.log');
function logCrash(tag, e) {
  const msg = `${new Date().toISOString()} [${tag}] ${e && e.stack ? e.stack : e}\n`;
  try { fs.appendFileSync(CRASH_LOG, msg); } catch (_) {}
  console.log(msg);
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

// 설치본(패키징)에서도 dev와 동일한 데이터 폴더(%APPDATA%/attendance-clock)를 쓰도록 앱 이름 고정
// — getPath('userData') 첫 호출 전에 setName 해야 함(아래 USER_DIR 계산에 반영)
app.setName('attendance-clock');
const USER_DIR = app.getPath('userData');
const DATA_DIR = path.join(USER_DIR, 'data');
const BACKUP_DIR = path.join(USER_DIR, 'backup');
const SEED_PATH = path.join(__dirname, 'seed.json');

// 컬렉션 파일명
const FILES = {
  settings: 'settings.json',
  employees: 'employees.json',
  punches: 'punches.json',          // append-only + 해시체인
  corrections: 'corrections.json',  // append-only + 해시체인
  auditLog: 'auditLog.json',        // append-only + 해시체인
  shiftTemplates: 'shiftTemplates.json',
  schedules: 'schedules.json',
  holidays: 'holidays.json',
  payrollSnapshots: 'payrollSnapshots.json'
};
// 해시체인으로 무결성 보호하는 append-only 컬렉션
const CHAINED = new Set(['punches', 'corrections', 'auditLog']);

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 파일 입출력 (원자적 쓰기)
// ---------------------------------------------------------------------------
function ensureDirs() {
  for (const d of [USER_DIR, DATA_DIR, BACKUP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// 임시파일에 쓰고 fsync 후 rename → 쓰는 도중 크래시에도 원본 보존
function writeJSONAtomic(file, obj) {
  ensureDirs();
  const tmp = file + '.tmp';
  const data = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function collPath(name) {
  return path.join(DATA_DIR, FILES[name]);
}

// 컬렉션 = { version, records:[...] }
function readColl(name) {
  const c = readJSON(collPath(name), null);
  if (c && Array.isArray(c.records)) return c;
  return { version: SCHEMA_VERSION, records: [] };
}

function writeColl(name, coll) {
  writeJSONAtomic(collPath(name), coll);
}

// ---------------------------------------------------------------------------
// 암호화 유틸 (PIN/관리자비번 해시, 해시체인)
// ---------------------------------------------------------------------------
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// 키를 정렬해 직렬화 → 해시 입력의 결정성 보장
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifySecret(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const calc = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// append-only 컬렉션에 해시체인을 걸어 추가
function appendChained(name, record) {
  const coll = readColl(name);
  const prevHash = coll.records.length
    ? coll.records[coll.records.length - 1].hashChain
    : 'GENESIS';
  record.prevHash = prevHash;
  const core = Object.assign({}, record);
  delete core.hashChain;
  record.hashChain = sha256(prevHash + stableStringify(core));
  coll.records.push(record);
  writeColl(name, coll);
  return record;
}

// 해시체인 무결성 검사
function verifyChain(name) {
  const coll = readColl(name);
  let prev = 'GENESIS';
  for (let i = 0; i < coll.records.length; i++) {
    const r = coll.records[i];
    const core = Object.assign({}, r);
    const stored = core.hashChain;
    delete core.hashChain;
    const calc = sha256(prev + stableStringify(core));
    if (r.prevHash !== prev || stored !== calc) {
      return { ok: false, brokenAt: i, total: coll.records.length };
    }
    prev = stored;
  }
  return { ok: true, total: coll.records.length };
}

// ---------------------------------------------------------------------------
// 감사 로그
// ---------------------------------------------------------------------------
function audit(event, summary, extra) {
  appendChained('auditLog', Object.assign({
    id: genId('aud'),
    at: Date.now(),
    actorRole: 'system',
    event,
    summary: summary || ''
  }, extra || {}));
}

// ---------------------------------------------------------------------------
// 날짜 유틸 (로컬=KST 기준)
// ---------------------------------------------------------------------------
function ymd(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// 초기화 (첫 실행 시 seed 로 구성)
// ---------------------------------------------------------------------------
let SETTINGS = null;

function defaultSettings() {
  return {
    businessName: '우리 호텔',
    fiveOrMore: true,
    timezone: 'Asia/Seoul',
    nightWindow: { start: '22:00', end: '06:00' },
    cancelWindowSec: 60, // 점각 후 취소 가능 시간
    maxShiftHoursForOpenSession: 18, // 열린 세션 인정 한계
    adminIdleSec: 120,
    kioskLock: false,
    backup: { everyMins: 30, keepDays: 30 },
    adminHash: null, // 첫 진입 시 설정
    schemaVersion: SCHEMA_VERSION
  };
}

function loadSettings() {
  const cur = readJSON(collPath('settings'), null);
  SETTINGS = Object.assign(defaultSettings(), cur || {});
  return SETTINGS;
}

function saveSettings() {
  writeJSONAtomic(collPath('settings'), SETTINGS);
}

function initData() {
  ensureDirs();
  const seed = readJSON(SEED_PATH, {});
  // settings
  if (!fs.existsSync(collPath('settings'))) {
    SETTINGS = Object.assign(defaultSettings(), seed.settings || {});
    saveSettings();
  } else {
    loadSettings();
  }
  // employees
  if (!fs.existsSync(collPath('employees'))) {
    writeColl('employees', { version: SCHEMA_VERSION, records: seed.employees || [] });
  }
  // shiftTemplates
  if (!fs.existsSync(collPath('shiftTemplates'))) {
    writeColl('shiftTemplates', { version: SCHEMA_VERSION, records: seed.shiftTemplates || [] });
  }
  // holidays (첫 실행 시 seed의 2026 공휴일)
  if (!fs.existsSync(collPath('holidays'))) {
    writeColl('holidays', { version: SCHEMA_VERSION, records: seed.holidays || [] });
  }
  // 나머지 빈 컬렉션
  for (const n of ['punches', 'corrections', 'auditLog', 'schedules', 'payrollSnapshots']) {
    if (!fs.existsSync(collPath(n))) writeColl(n, { version: SCHEMA_VERSION, records: [] });
  }
}

// ---------------------------------------------------------------------------
// 직원
// ---------------------------------------------------------------------------
function listEmployees() {
  return readColl('employees').records;
}

function getEmployee(id) {
  return listEmployees().find((e) => e.id === id) || null;
}

// 키오스크용 공개 정보(민감정보 제외) + 현재 상태
function listEmployeesPublic() {
  return listEmployees()
    .filter((e) => e.active !== false)
    .map((e) => ({
      id: e.id,
      name: e.name,
      empNo: e.empNo || '',
      status: getStatus(e.id)
    }));
}

function saveEmployee(emp) {
  const coll = readColl('employees');
  const now = Date.now();
  if (emp.id) {
    const idx = coll.records.findIndex((e) => e.id === emp.id);
    if (idx < 0) return { ok: false, error: '직원을 찾을 수 없습니다.' };
    const prev = coll.records[idx];
    // PIN 은 별도 경로로만 변경 — 여기선 보존
    const merged = Object.assign({}, prev, emp, {
      pinHash: prev.pinHash,
      updatedAt: now
    });
    coll.records[idx] = merged;
    writeColl('employees', coll);
    audit('employee.update', `직원 수정: ${merged.name}`, { actorRole: 'admin', entityId: merged.id });
    return { ok: true, employee: stripEmp(merged) };
  }
  // 신규
  const rec = Object.assign({
    id: genId('emp'),
    active: true,
    createdAt: now,
    updatedAt: now,
    pinHash: emp._pin ? hashSecret(emp._pin) : null
  }, emp);
  delete rec._pin;
  coll.records.push(rec);
  writeColl('employees', coll);
  audit('employee.create', `직원 등록: ${rec.name}`, { actorRole: 'admin', entityId: rec.id });
  return { ok: true, employee: stripEmp(rec) };
}

function setEmployeePin(id, pin) {
  if (!/^\d{4}$/.test(String(pin))) return { ok: false, error: 'PIN은 숫자 4자리여야 합니다.' };
  const coll = readColl('employees');
  const idx = coll.records.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: '직원을 찾을 수 없습니다.' };
  coll.records[idx].pinHash = hashSecret(pin);
  coll.records[idx].pinUpdatedAt = Date.now();
  coll.records[idx].updatedAt = Date.now();
  writeColl('employees', coll);
  audit('employee.pin', `PIN 변경: ${coll.records[idx].name}`, { actorRole: 'admin', entityId: id });
  return { ok: true };
}

function deactivateEmployee(id) {
  const coll = readColl('employees');
  const idx = coll.records.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: '직원을 찾을 수 없습니다.' };
  coll.records[idx].active = false;
  coll.records[idx].resignDate = ymd(Date.now());
  coll.records[idx].updatedAt = Date.now();
  writeColl('employees', coll);
  audit('employee.deactivate', `퇴사 처리: ${coll.records[idx].name}`, { actorRole: 'admin', entityId: id });
  return { ok: true };
}

// 직원 완전 삭제 — 단, 점각 기록/보정이 있으면 차단(근태·급여 이력 보존). 그 경우 퇴사 처리 권장.
function deleteEmployee(id) {
  const punches = readColl('punches').records.filter((p) => p.empId === id).length;
  const corr = readColl('corrections').records.filter((c) => c.empId === id).length;
  if (punches + corr > 0) {
    return { ok: false, hasRecords: true, count: punches + corr,
      error: `이 직원은 점각/보정 기록이 ${punches + corr}건 있어 삭제할 수 없습니다.\n근태·급여 이력 보존을 위해 [퇴사 처리]를 사용하세요.` };
  }
  const coll = readColl('employees');
  const idx = coll.records.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: '직원을 찾을 수 없습니다.' };
  const name = coll.records[idx].name;
  coll.records.splice(idx, 1);
  writeColl('employees', coll);
  audit('employee.delete', `직원 삭제: ${name}`, { actorRole: 'admin', entityId: id });
  return { ok: true };
}

// 관리자 화면에 줄 직원 정보(PIN 해시 제외, PIN 설정여부만)
function stripEmp(e) {
  const o = Object.assign({}, e);
  o.pinSet = !!o.pinHash;
  delete o.pinHash;
  return o;
}

// ---------------------------------------------------------------------------
// 점각 — 유효 점각 합성(원본 + 보정)
// ---------------------------------------------------------------------------
function effectivePunches(empId) {
  const raw = readColl('punches').records.filter((p) => p.empId === empId);
  const corr = readColl('corrections').records.filter((c) => c.empId === empId);
  const byId = new Map();
  for (const p of raw) byId.set(p.id, Object.assign({}, p, { voided: false }));

  // 보정 적용 (시간순)
  const corrSorted = corr.slice().sort((a, b) => a.ts - b.ts);
  for (const c of corrSorted) {
    if (c.action === 'void' && c.targetPunchId && byId.has(c.targetPunchId)) {
      byId.get(c.targetPunchId).voided = true;
    } else if (c.action === 'edit_time' && c.targetPunchId && byId.has(c.targetPunchId)) {
      const t = byId.get(c.targetPunchId);
      if (c.after && typeof c.after.ts === 'number') t.ts = c.after.ts;
      if (c.after && c.after.type) t.type = c.after.type;
    } else if (c.action === 'add_missing' && c.after) {
      byId.set(c.id, {
        id: c.id,
        empId,
        type: c.after.type,
        ts: c.after.ts,
        workDate: c.workDate || ymd(c.after.ts),
        source: 'admin',
        raw: false,
        voided: false
      });
    }
  }
  return Array.from(byId.values())
    .filter((p) => !p.voided)
    .sort((a, b) => a.ts - b.ts);
}

// 현재 근무 상태 계산
function getStatus(empId) {
  const eff = effectivePunches(empId);
  let openIn = null;
  for (const p of eff) {
    if (p.type === 'in') openIn = p;
    else if (p.type === 'out') openIn = null;
  }
  const now = Date.now();
  // 열린 세션 인정 한계 — 교대/격일 근무자는 자정을 넘겨 다음날(최대 24h+) 퇴근하므로 넉넉히(≥30h),
  // 고정직은 기본값(18h). 경계값(예: 16:00→다음날 10:00 = 정확히 18h)도 인정하도록 '<=' 사용.
  const stEmp = getEmployee(empId);
  const baseLimitH = SETTINGS.maxShiftHoursForOpenSession || 18;
  const limitH = (stEmp && stEmp.scheduleType === 'shift') ? Math.max(baseLimitH, 30) : baseLimitH;
  const limitMs = limitH * 3600 * 1000;
  let working = false;
  if (openIn && now - openIn.ts <= limitMs) working = true;

  const today = ymd(now);
  const todays = eff.filter((p) => (p.workDate || ymd(p.ts)) === today);
  const lastIn = [...eff].reverse().find((p) => p.type === 'in') || null;
  const lastOut = [...eff].reverse().find((p) => p.type === 'out') || null;

  return {
    state: working ? 'working' : 'idle',
    canIn: !working,
    canOut: working,
    openSince: openIn ? openIn.ts : null,
    openWorkDate: openIn ? openIn.workDate || ymd(openIn.ts) : null,
    lastIn: lastIn ? lastIn.ts : null,
    lastOut: lastOut ? lastOut.ts : null,
    todayInCount: todays.filter((p) => p.type === 'in').length,
    todayOutCount: todays.filter((p) => p.type === 'out').length
  };
}

// 점각 기록(PIN 검증 후)
function doPunch(empId, pin, type) {
  const emp = getEmployee(empId);
  if (!emp || emp.active === false) return { ok: false, error: '등록되지 않은 직원입니다.' };
  if (!emp.pinHash) return { ok: false, error: 'PIN이 설정되지 않았습니다. 관리자에게 문의하세요.' };
  if (!verifySecret(pin, emp.pinHash)) {
    audit('punch.pinfail', `PIN 불일치: ${emp.name}`, { entityId: empId });
    return { ok: false, error: 'PIN이 맞지 않습니다.' };
  }

  const status = getStatus(empId);
  const now = Date.now();

  if (type === 'in') {
    if (status.state === 'working') {
      return { ok: false, error: `이미 근무중입니다 (출근 ${fmtTime(status.openSince)}).` };
    }
  } else if (type === 'out') {
    if (status.state !== 'working') {
      return { ok: false, error: '출근 기록이 없습니다. 먼저 출근을 눌러주세요.' };
    }
  } else {
    return { ok: false, error: '잘못된 요청입니다.' };
  }

  // workDate: 출근=오늘, 퇴근=열린세션의 귀속일(야간 자정넘김 대응)
  const workDate = type === 'in' ? ymd(now) : (status.openWorkDate || ymd(now));

  const rec = appendChained('punches', {
    id: genId('pch'),
    empId,
    type,
    ts: now,
    occurredDate: ymd(now),
    workDate,
    source: 'kiosk',
    method: 'pin',
    raw: true,
    createdAt: now
  });
  audit('punch.create', `${emp.name} ${type === 'in' ? '출근' : '퇴근'} ${fmtTime(now)}`, { entityId: rec.id, empId });

  return {
    ok: true,
    record: { id: rec.id, type, ts: now, workDate },
    canCancelUntilMs: (SETTINGS.cancelWindowSec || 60) * 1000,
    employeeName: emp.name
  };
}

// 점각 취소(취소 허용시간 내) — 원본은 두고 void 보정 추가
function cancelPunch(punchId, empId, pin) {
  const emp = getEmployee(empId);
  if (!emp) return { ok: false, error: '직원을 찾을 수 없습니다.' };
  if (!verifySecret(pin, emp.pinHash)) return { ok: false, error: 'PIN이 맞지 않습니다.' };
  const p = readColl('punches').records.find((x) => x.id === punchId && x.empId === empId);
  if (!p) return { ok: false, error: '점각 기록을 찾을 수 없습니다.' };
  const windowMs = (SETTINGS.cancelWindowSec || 60) * 1000;
  if (Date.now() - p.createdAt > windowMs) {
    return { ok: false, error: '취소 가능 시간이 지났습니다. 관리자에게 문의하세요.' };
  }
  appendChained('corrections', {
    id: genId('cor'),
    targetType: 'punch',
    targetPunchId: punchId,
    empId,
    workDate: p.workDate,
    action: 'void',
    reason: '본인 취소(취소시간 내)',
    by: 'self',
    ts: Date.now()
  });
  audit('punch.cancel', `${emp.name} 점각 취소 (${p.type === 'in' ? '출근' : '퇴근'})`, { entityId: punchId, empId });
  return { ok: true };
}

function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 관리자: 기간별 유효 점각 조회 (월 단위)
function listPunches(filter) {
  filter = filter || {};
  const emps = listEmployees();
  const out = [];
  for (const e of emps) {
    if (filter.empId && filter.empId !== e.id) continue;
    const eff = effectivePunches(e.id);
    for (const p of eff) {
      const wd = p.workDate || ymd(p.ts);
      if (filter.month && wd.slice(0, 7) !== filter.month) continue;
      out.push({ empId: e.id, empName: e.name, type: p.type, ts: p.ts, workDate: wd, source: p.source, raw: p.raw !== false });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  // workDate+직원 단위로 출근/퇴근 묶기
  const groups = {};
  for (const p of out) {
    const key = p.empId + '|' + p.workDate;
    if (!groups[key]) groups[key] = { empId: p.empId, empName: p.empName, workDate: p.workDate, ins: [], outs: [] };
    if (p.type === 'in') groups[key].ins.push(p.ts);
    else groups[key].outs.push(p.ts);
  }
  return Object.values(groups)
    .map((g) => {
      const firstIn = g.ins.length ? Math.min(...g.ins) : null;
      const lastOut = g.outs.length ? Math.max(...g.outs) : null;
      const grossMin = firstIn && lastOut && lastOut > firstIn ? Math.round((lastOut - firstIn) / 60000) : null;
      return {
        empId: g.empId,
        empName: g.empName,
        workDate: g.workDate,
        firstIn,
        lastOut,
        grossMinutes: grossMin,
        missingOut: g.ins.length > 0 && g.outs.length === 0,
        flags: g.ins.length > 1 || g.outs.length > 1 ? '다중점각' : ''
      };
    })
    .sort((a, b) => (a.workDate < b.workDate ? 1 : a.workDate > b.workDate ? -1 : a.empName.localeCompare(b.empName)));
}

// ---------------------------------------------------------------------------
// 급여 집계 (calc 엔진)
// ---------------------------------------------------------------------------
function holidaysSet() {
  return new Set(readColl('holidays').records.map((h) => h.date));
}
function calcSettings() {
  return {
    standardWeeklyHours: SETTINGS.standardWeeklyHours || 40,
    grace: SETTINGS.grace || { lateIn: 5, earlyOut: 5 },
    monthlyContractHours: SETTINGS.monthlyContractHours || 209
  };
}
// 근무표(예정) 가져온 것을 그달 직원(extId)별 일자맵으로 — 교대직 결근/지각/조퇴 판정용
function schedulePlanForMonth(month) {
  const coll = readColl('schedules');
  const out = {};
  for (const r of coll.records) {
    if (!r || !r.extId || !r.date) continue;
    if (String(r.date).slice(0, 7) !== month) continue;
    (out[r.extId] = out[r.extId] || {})[r.date] = { start: r.start || '', end: r.end || '', overnight: !!r.overnight, kind: r.kind || '근무' };
  }
  return out;
}
function computePayroll(month) {
  const hs = holidaysSet();
  const cs = calcSettings();
  const planByExt = schedulePlanForMonth(month);
  return listEmployees()
    .filter((e) => e.active !== false)
    .map((e) => calc.computeEmployeeMonth(e, effectivePunches(e.id), hs, month, cs, (e.extId && planByExt[e.extId]) || null))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function exportPayrollXlsx(month, filePath) {
  const rows = computePayroll(month);
  const hh = (m) => Math.round((m / 60) * 100) / 100; // 분→시간(소수2)
  const aoa = [
    [`${month} 근태·수당 집계 (출퇴근 점각앱) — 운영관리 추가근무 반영용`],
    ['직원ID', '이름', '지역', '급여형태', '정상시간', '연장시간', '야간시간', '휴일시간',
      '지각(일)', '지각(분)', '조퇴(일)', '조퇴(분)', '결근(일)', '주휴시간',
      '연장수당', '야간수당', '휴일수당', '주휴수당', '가산합계(참고)', '미퇴근(일)']
  ];
  rows.forEach((r) => {
    aoa.push([
      r.extId || '', r.name, r.region || '', r.payType === 'monthly' ? '월급' : '시급',
      hh(r.regularMin), hh(r.overtimeMin), hh(r.nightMin), hh(r.holidayMin),
      r.lateDays, r.lateMin, r.earlyDays, r.earlyMin, r.absentDays, hh(r.weeklyHolidayMin),
      r.otPay, r.nightPay, r.holiPay, r.weeklyHolidayPay, r.addTotal, r.unclosedDays
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[1].map(() => ({ wch: 10 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '근태집계');
  XLSX.writeFile(wb, filePath);
  return rows.length;
}

// ---------------------------------------------------------------------------
// 월마감(스냅샷 동결) + 관리자 점각 보정
// ---------------------------------------------------------------------------
function isMonthClosed(month) {
  return readColl('payrollSnapshots').records.some((s) => s.month === month);
}
function getSnapshot(month) {
  return readColl('payrollSnapshots').records.find((s) => s.month === month) || null;
}
function closePayroll(month) {
  const rows = computePayroll(month);
  const coll = readColl('payrollSnapshots');
  const idx = coll.records.findIndex((s) => s.month === month);
  const snap = { month, closedAt: Date.now(), rows };
  if (idx >= 0) coll.records[idx] = snap; else coll.records.push(snap);
  writeColl('payrollSnapshots', coll);
  audit('payroll.close', `${month} 월마감 (${rows.length}명 동결)`, { actorRole: 'admin' });
  return { ok: true, closedAt: snap.closedAt };
}
function reopenPayroll(month) {
  const coll = readColl('payrollSnapshots');
  const before = coll.records.length;
  coll.records = coll.records.filter((s) => s.month !== month);
  if (coll.records.length !== before) { writeColl('payrollSnapshots', coll); audit('payroll.reopen', `${month} 마감 취소`, { actorRole: 'admin' }); }
  return { ok: true };
}
// 관리자 보정 — 원본 불변, 보정 레코드만 추가(사유 필수). 마감월은 차단.
function addCorrection(p) {
  const emp = getEmployee(p.empId);
  if (!emp) return { ok: false, error: '직원을 찾을 수 없습니다.' };
  if (!p.reason || !String(p.reason).trim()) return { ok: false, error: '보정 사유를 입력하세요.' };
  const month = String(p.workDate || '').slice(0, 7);
  if (isMonthClosed(month)) return { ok: false, error: `${month}은 월마감되어 보정할 수 없습니다. 먼저 마감을 취소하세요.` };
  const rec = { id: genId('cor'), empId: p.empId, workDate: p.workDate, reason: String(p.reason).trim(), by: 'admin', ts: Date.now() };
  if (p.action === 'void') {
    if (!p.targetPunchId) return { ok: false, error: '대상 점각이 없습니다.' };
    rec.action = 'void'; rec.targetType = 'punch'; rec.targetPunchId = p.targetPunchId;
  } else if (p.action === 'edit_time') {
    if (!p.targetPunchId) return { ok: false, error: '대상 점각이 없습니다.' };
    if (!(typeof p.newTs === 'number' && p.newTs > 0)) return { ok: false, error: '시각이 올바르지 않습니다.' };
    rec.action = 'edit_time'; rec.targetType = 'punch'; rec.targetPunchId = p.targetPunchId; rec.after = { ts: p.newTs };
  } else if (p.action === 'add_missing') {
    if (!(typeof p.newTs === 'number' && p.newTs > 0)) return { ok: false, error: '시각이 올바르지 않습니다.' };
    rec.action = 'add_missing'; rec.after = { type: p.newType === 'in' ? 'in' : 'out', ts: p.newTs };
  } else return { ok: false, error: '알 수 없는 보정 동작입니다.' };
  appendChained('corrections', rec);
  audit('punch.correct', `${emp.name} ${p.workDate} 보정(${rec.action}): ${rec.reason}`, { actorRole: 'admin', empId: p.empId });
  return { ok: true };
}
function punchDetail(empId, workDate) {
  return effectivePunches(empId)
    .filter((p) => (p.workDate || ymd(p.ts)) === workDate)
    .map((p) => ({ id: p.id, type: p.type, ts: p.ts, source: p.source || 'kiosk', raw: p.raw !== false }));
}

// 과거 점각 일괄등록 — 양식 생성(직원×날짜) / 작성본 가져오기(출근·퇴근 → punches)
function bulkTemplateXlsx(start, end, filePath) {
  const emps = listEmployees().filter((e) => e.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const dates = [];
  let d = new Date(start + 'T00:00:00'); const endD = new Date(end + 'T00:00:00');
  for (let guard = 0; d <= endD && guard < 400; guard++) { dates.push(ymd(d.getTime())); d.setDate(d.getDate() + 1); }
  const wd = ['일', '월', '화', '수', '목', '금', '토'];
  const wb = XLSX.utils.book_new();
  // 안내 시트
  const guide = XLSX.utils.aoa_to_sheet([
    ['점각 일괄등록 양식'],
    [`기간  ${start} ~ ${end}     ·     직원 ${emps.length}명`],
    [''],
    ['1) 직원마다 아래에 시트(탭)가 하나씩 있습니다. 각 직원 탭을 눌러 입력하세요.'],
    ['2) 각 날짜의 출근/퇴근을 HH:MM(예 09:00, 18:00)으로 입력. 근무 안 한 날은 비워두세요.'],
    ['3) 야간 근무는 퇴근이 다음날이어도 그대로(예 06:00) 적으면 자동 인식됩니다.'],
    ['4) 시트 위쪽 직원ID·이름과 날짜 칸은 수정하지 마세요. 출근·퇴근만 입력.']
  ]);
  guide['!cols'] = [{ wch: 95 }];
  XLSX.utils.book_append_sheet(wb, guide, '안내');
  const used = { '안내': true };
  emps.forEach((e) => {
    const aoa = [
      ['직원ID', e.extId || ''],
      ['이름', e.name],
      ['지점', e.region || ''],
      [''],
      ['날짜', '요일', '출근', '퇴근'],
      ...dates.map((ds) => [ds, wd[new Date(ds + 'T00:00:00').getDay()], '', ''])
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 10 }, { wch: 10 }];
    const base = (String(e.name).replace(/[:\\/?*\[\]]/g, ' ').trim().slice(0, 28)) || '직원';
    let nm = base, n = 1;
    while (used[nm]) { nm = base.slice(0, 25) + '_' + (++n); }
    used[nm] = true;
    XLSX.utils.book_append_sheet(wb, ws, nm);
  });
  XLSX.writeFile(wb, filePath);
  return { employees: emps.length, dates: dates.length, rows: emps.length * dates.length };
}
function bulkImportPunches(filePath) {
  let wb;
  try { wb = XLSX.readFile(filePath, { cellDates: true }); } catch (e) { return { ok: false, error: '엑셀을 읽지 못했습니다: ' + (e && e.message ? e.message : e) }; }
  const norm = (row) => (row || []).map((c) => String(c == null ? '' : c).replace(/\s/g, ''));
  const txt = (v) => (v instanceof Date) ? ymd(v.getTime()) : String(v == null ? '' : v).trim();
  const hm = (v) => { if (v instanceof Date) return String(v.getHours()).padStart(2, '0') + ':' + String(v.getMinutes()).padStart(2, '0'); const m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/); return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : ''; };
  // 라벨(예 '직원ID') 셀을 찾아 그 오른쪽 첫 값 반환 (개인별 시트 식별용)
  const labelValue = (rows, label) => {
    for (let i = 0; i < Math.min(rows.length, 8); i++) {
      const r = rows[i] || [];
      for (let j = 0; j < r.length; j++) {
        if (String(r[j] == null ? '' : r[j]).replace(/\s/g, '') === label) {
          for (let k = j + 1; k < r.length; k++) { const v = String(r[k] == null ? '' : r[k]).trim(); if (v) return v; }
        }
      }
    }
    return '';
  };
  const emps = listEmployees();
  const now = Date.now();
  let added = 0, skipped = 0; const errors = [];
  const addPunch = (emp, date, inT, outT) => {
    if (isMonthClosed(date.slice(0, 7))) { errors.push(`${emp.name} ${date}: ${date.slice(0, 7)} 마감됨`); return; }
    const eff = effectivePunches(emp.id).filter((p) => (p.workDate || ymd(p.ts)) === date);
    const hasIn = eff.some((p) => p.type === 'in'), hasOut = eff.some((p) => p.type === 'out');
    if (inT) { if (hasIn) skipped++; else { appendChained('punches', { id: genId('pch'), empId: emp.id, type: 'in', ts: calc.dateAtTime(date, inT), occurredDate: date, workDate: date, source: 'import', method: 'bulk', raw: false, createdAt: now }); added++; } }
    if (outT) {
      if (hasOut) skipped++;
      else {
        let outTs = calc.dateAtTime(date, outT);
        if (inT && outTs <= calc.dateAtTime(date, inT)) outTs += 86400000; // 자정 넘는 야간 → 익일
        appendChained('punches', { id: genId('pch'), empId: emp.id, type: 'out', ts: outTs, occurredDate: ymd(outTs), workDate: date, source: 'import', method: 'bulk', raw: false, createdAt: now }); added++;
      }
    }
  };
  let anyTable = false;
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    let h = -1, flat = false;
    for (let i = 0; i < Math.min(rows.length, 15); i++) { const s = norm(rows[i]); if (s.indexOf('날짜') !== -1) { h = i; flat = s.indexOf('이름') !== -1; break; } }
    if (h < 0) continue; // 안내/요약 시트
    const header = norm(rows[h]);
    const col = (...ns) => { for (const nm of ns) { const i = header.indexOf(nm); if (i !== -1) return i; } return -1; };
    const cDate = col('날짜'), cIn = col('출근', '출근시각'), cOut = col('퇴근', '퇴근시각');
    if (cDate < 0 || (cIn < 0 && cOut < 0)) continue;
    anyTable = true;
    if (flat) {
      // 구 양식(한 시트에 직원ID·이름·날짜·출근·퇴근)
      const cExt = col('직원ID', 'ID'), cName = col('이름', '성명');
      for (let i = h + 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const name = cName >= 0 ? txt(r[cName]) : '', extId = cExt >= 0 ? txt(r[cExt]) : '';
        const date = txt(r[cDate]), inT = cIn >= 0 ? hm(r[cIn]) : '', outT = cOut >= 0 ? hm(r[cOut]) : '';
        if ((!name && !extId) || (!inT && !outT)) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`${name || extId} ${date}: 날짜 형식 오류`); continue; }
        const emp = (extId && emps.find((e) => e.extId === extId)) || emps.find((e) => e.name === name);
        if (!emp) { errors.push(`${name || extId} ${date}: 직원 미등록`); continue; }
        addPunch(emp, date, inT, outT);
      }
    } else {
      // 개인별 시트: 시트 위쪽 직원ID/이름으로 직원 식별
      const extId = labelValue(rows, '직원ID'), nm = labelValue(rows, '이름') || sheetName;
      const emp = (extId && emps.find((e) => e.extId === extId)) || emps.find((e) => e.name === nm);
      if (!emp) { errors.push(`시트 '${sheetName}'(${nm || extId || '?'}): 직원 미등록`); continue; }
      for (let i = h + 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const date = txt(r[cDate]), inT = cIn >= 0 ? hm(r[cIn]) : '', outT = cOut >= 0 ? hm(r[cOut]) : '';
        if (!inT && !outT) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`${emp.name} ${date}: 날짜 형식 오류`); continue; }
        addPunch(emp, date, inT, outT);
      }
    }
  }
  if (!anyTable) return { ok: false, error: '양식을 찾지 못했습니다(시트에 "날짜" 머리글이 필요합니다).' };
  audit('punch.bulkImport', `점각 일괄등록 (추가 ${added}, 건너뜀 ${skipped}, 오류 ${errors.length})`, { actorRole: 'admin' });
  return { ok: true, added, skipped, errorCount: errors.length, errors: errors.slice(0, 15) };
}

// ---------------------------------------------------------------------------
// 백업
// ---------------------------------------------------------------------------
let backupTimer = null;

function runBackup(reason) {
  try {
    ensureDirs();
    const d = new Date();
    const stamp = ymd(d.getTime()) + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
    const dest = path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dest, { recursive: true });
    for (const n of Object.keys(FILES)) {
      const src = collPath(n);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, FILES[n]));
    }
    cleanupBackups();
    return { ok: true, dest, stamp };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function cleanupBackups() {
  const keepDays = (SETTINGS.backup && SETTINGS.backup.keepDays) || 30;
  const cutoff = Date.now() - keepDays * 86400000;
  try {
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      const full = path.join(BACKUP_DIR, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }
}

function startBackupTimer() {
  if (backupTimer) clearInterval(backupTimer);
  const mins = (SETTINGS.backup && SETTINGS.backup.everyMins) || 30;
  backupTimer = setInterval(() => runBackup('auto'), Math.max(5, mins) * 60000);
}

// ---------------------------------------------------------------------------
// 관리자 세션 (간이 잠금)
// ---------------------------------------------------------------------------
let adminUnlockedAt = 0;
function adminOk() {
  return adminUnlockedAt && Date.now() - adminUnlockedAt < (SETTINGS.adminIdleSec || 120) * 1000;
}
function touchAdmin() { adminUnlockedAt = Date.now(); }
function requireAdmin() {
  if (!adminOk()) return { ok: false, error: '관리자 인증이 필요합니다.' };
  touchAdmin();
  return null;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('settings:get', () => {
  return {
    businessName: SETTINGS.businessName,
    fiveOrMore: SETTINGS.fiveOrMore,
    cancelWindowSec: SETTINGS.cancelWindowSec,
    kioskLock: SETTINGS.kioskLock,
    adminIsSet: !!SETTINGS.adminHash,
    appVersion: app.getVersion()
  };
});

ipcMain.handle('admin:status', () => ({ unlocked: adminOk(), adminIsSet: !!SETTINGS.adminHash }));

ipcMain.handle('admin:setPassword', (_e, pw) => {
  // 최초 설정 또는 인증된 상태에서 변경만 허용
  if (SETTINGS.adminHash && !adminOk()) return { ok: false, error: '현재 비밀번호 인증이 필요합니다.' };
  if (!pw || String(pw).length < 4) return { ok: false, error: '비밀번호는 4자 이상이어야 합니다.' };
  SETTINGS.adminHash = hashSecret(pw);
  saveSettings();
  touchAdmin();
  audit('admin.setPassword', '관리자 비밀번호 설정/변경', { actorRole: 'admin' });
  return { ok: true };
});

ipcMain.handle('admin:verify', (_e, pw) => {
  if (!SETTINGS.adminHash) return { ok: false, error: '비밀번호가 설정되지 않았습니다.' };
  if (verifySecret(pw, SETTINGS.adminHash)) {
    touchAdmin();
    audit('admin.login', '관리자 로그인', { actorRole: 'admin' });
    return { ok: true };
  }
  audit('admin.loginfail', '관리자 로그인 실패');
  return { ok: false, error: '비밀번호가 맞지 않습니다.' };
});

ipcMain.handle('admin:lock', () => { adminUnlockedAt = 0; return { ok: true }; });

// 키오스크
ipcMain.handle('emp:listPublic', () => listEmployeesPublic());
ipcMain.handle('emp:status', (_e, empId) => getStatus(empId));
ipcMain.handle('emp:verifyPin', (_e, empId, pin) => {
  const emp = getEmployee(empId);
  if (!emp || emp.active === false) return { ok: false, error: '등록되지 않은 직원입니다.' };
  if (!emp.pinHash) return { ok: false, error: 'PIN이 설정되지 않았습니다. 관리자에게 문의하세요.' };
  if (!verifySecret(pin, emp.pinHash)) {
    audit('punch.pinfail', `PIN 불일치: ${emp.name}`, { entityId: empId });
    return { ok: false, error: 'PIN이 맞지 않습니다.' };
  }
  return { ok: true, status: getStatus(empId), name: emp.name };
});
ipcMain.handle('punch:do', (_e, empId, pin, type) => doPunch(empId, pin, type));
ipcMain.handle('punch:cancel', (_e, punchId, empId, pin) => cancelPunch(punchId, empId, pin));

// 관리자 전용
ipcMain.handle('emp:listFull', () => {
  const g = requireAdmin(); if (g) return g;
  return { ok: true, employees: listEmployees().map(stripEmp) };
});
ipcMain.handle('emp:save', (_e, emp) => {
  const g = requireAdmin(); if (g) return g;
  return saveEmployee(emp);
});
ipcMain.handle('emp:setPin', (_e, id, pin) => {
  const g = requireAdmin(); if (g) return g;
  return setEmployeePin(id, pin);
});
ipcMain.handle('emp:deactivate', (_e, id) => {
  const g = requireAdmin(); if (g) return g;
  return deactivateEmployee(id);
});
ipcMain.handle('emp:delete', (_e, id) => {
  const g = requireAdmin(); if (g) return g;
  return deleteEmployee(id);
});

// 직원명부 엑셀 가져오기 (운영관리앱에서 내보낸 직원명부.xlsx → 파일 선택)
//  - 두 앱은 서로 다른 PC(점각=공용 PC, 운영관리=관리자 PC) → USB/메신저로 옮긴 엑셀을 선택
//  - 매칭: 직원ID(=운영관리 id) 우선, 없으면 이름+지역
//  - 병합(upsert): 점각앱에만 있는 PIN·근무형태·휴게는 보존하고 이름·급여형태만 갱신
//  - 헤더: 직원ID | 이름 | 사번 | 지역 | 부서 | 급여형태 | 시급 | 월기본급 | 입사일  (열 순서 바뀌어도 머리글로 매칭)
ipcMain.handle('emp:importRoster', async () => {
  const g = requireAdmin(); if (g) return g;
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '직원 명단 엑셀 선택 (직원명부 또는 급여근거)',
    properties: ['openFile'],
    filters: [{ name: '엑셀', extensions: ['xlsx', 'xls'] }]
  });
  if (canceled || !filePaths.length) return { ok: false, error: '취소되었습니다.' };

  let rows;
  try {
    const wb = XLSX.readFile(filePaths[0], { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  } catch (e) {
    return { ok: false, error: '엑셀을 읽지 못했습니다: ' + (e && e.message ? e.message : e) };
  }
  // 머리글 행 탐색 — 직원명부(이름/성명) 또는 급여근거(구분+재직장소/월급여) 형식 모두 인식
  const norm = (row) => (row || []).map((c) => String(c == null ? '' : c).replace(/\s/g, ''));
  const isHeaderRow = (row) => {
    const s = norm(row);
    const has = (x) => s.indexOf(x) !== -1;
    return has('이름') || has('성명') || (has('구분') && (has('재직장소') || has('월급여') || has('입사구분')));
  };
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 12); i++) { if (rows[i] && isHeaderRow(rows[i])) { h = i; break; } }
  if (h < 0) return { ok: false, error: '직원 명단 형식을 찾지 못했습니다. 머리글에 "이름"(직원명부) 또는 "구분/재직장소"(급여근거)가 있어야 합니다.' };
  const header = norm(rows[h]);
  const col = (...names) => { for (const nm of names) { const i = header.indexOf(nm); if (i !== -1) return i; } return -1; };
  const cId = col('직원ID', 'ID', '운영관리ID');
  const cName = col('이름', '성명', '구분');
  const cNo = col('사번');
  const cRegion = col('지역', '지점', '재직장소');
  const cDept = col('부서', '부서직책', '직위', '직책');
  const cPay = col('급여형태'), cHourly = col('시급', '시급원'), cMonthly = col('월기본급', '월급', '월급여'), cHire = col('입사일');
  const cCond = col('근무조건', '근무유형');
  const fmt = (v) => (v instanceof Date) ? ymd(v.getTime()) : String(v == null ? '' : v).trim();
  const num = (v) => Number(String(v == null ? '' : v).replace(/[,\s원]/g, '')) || 0;
  // 근무조건 → 근무요일/교대 ('주5일 8시간'→월~금, '주6일'→월~토, '격일제/교대'→shift)
  const condToSched = (cond) => {
    const c = String(cond || '').replace(/\s/g, '');
    if (!c) return null;
    if (/격일|교대|시프트|shift/i.test(c)) return { scheduleType: 'shift' };
    const m = c.match(/주([1-7])/) || c.match(/([1-7])일/);
    if (m) {
      const map = { 1: [1], 2: [1, 2], 3: [1, 2, 3], 4: [1, 2, 3, 4], 5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6], 7: [0, 1, 2, 3, 4, 5, 6] };
      return { scheduleType: 'fixed', workDays: map[Number(m[1])] };
    }
    return null;
  };

  const coll = readColl('employees');
  let imported = 0, skipped = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const name = cName >= 0 ? fmt(r[cName]) : '';
    if (!name || name === '구분' || /합\s*계|총\s*계|소\s*계/.test(name)) continue;
    const extId = cId >= 0 ? fmt(r[cId]) : '';
    const region = cRegion >= 0 ? fmt(r[cRegion]) : '';
    const empNo = cNo >= 0 ? fmt(r[cNo]) : '';
    const dept = cDept >= 0 ? fmt(r[cDept]) : '';
    const hireDate = cHire >= 0 ? fmt(r[cHire]) : '';
    const monthly = cMonthly >= 0 ? num(r[cMonthly]) : 0;
    const hourly = cHourly >= 0 ? num(r[cHourly]) : 0;
    const payRaw = cPay >= 0 ? fmt(r[cPay]) : '';
    const payType = /월/.test(payRaw) ? 'monthly' : (/시/.test(payRaw) ? 'hourly' : (monthly > 0 ? 'monthly' : 'hourly'));
    const sched = cCond >= 0 ? condToSched(r[cCond]) : null;
    // 이미 등록된 직원은 제외하고 신규만 등록(중복 방지).
    //  - 직원ID 있으면 직원ID로 판정(동명이인 각각 등록·재업로드 시 걸러짐)
    //  - 직원ID 없으면(급여근거) 이름으로 판정
    const exists = extId
      ? coll.records.some((e) => e.extId === extId)
      : coll.records.some((e) => e.name === name);
    if (exists) { skipped++; continue; }
    coll.records.push({
      id: genId('emp'), extId: extId || null, name, empNo, region, dept, hireDate, payType,
      wage: { hourlyRate: hourly, monthlySalary: monthly, monthlyContractHours: 209 },
      scheduleType: sched ? sched.scheduleType : 'fixed',
      workDays: sched && sched.workDays ? sched.workDays : [1, 2, 3, 4, 5],
      shiftStart: '09:00', shiftEnd: '18:00', breakMinutes: 60,
      pinHash: hashSecret('1234'), pinUpdatedAt: Date.now(), active: true, createdAt: Date.now(), updatedAt: Date.now()
    });
    imported++;
  }
  writeColl('employees', coll);
  audit('employee.importRoster', `직원명부 가져오기 (신규 ${imported}명, 기존제외 ${skipped}명)`, { actorRole: 'admin' });
  return { ok: true, imported, skipped, src: path.basename(filePaths[0]) };
});
// 근무표(예정) 엑셀 가져오기 — 운영관리에서 내보낸 점각용 파일 → schedules(extId×날짜 예정시각)
ipcMain.handle('schedule:importPlan', async () => {
  const g = requireAdmin(); if (g) return g;
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '근무표 엑셀 선택 (운영관리 점각용 파일 또는 손으로 만든 근무표 원본)',
    properties: ['openFile'], filters: [{ name: '엑셀', extensions: ['xlsx', 'xls'] }]
  });
  if (canceled || !filePaths.length) return { ok: false, error: '취소되었습니다.' };
  let wb;
  try { wb = XLSX.readFile(filePaths[0], { cellDates: true }); }
  catch (e) { return { ok: false, error: '엑셀을 읽지 못했습니다: ' + (e && e.message ? e.message : e) }; }

  let incoming, months, exts, gridInfo = null;
  // 1) 점각용(평평한) 형식: 첫 시트 머리글에 '직원ID'+'날짜'
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i]; if (!r) continue;
    const flat = r.map((c) => String(c == null ? '' : c).replace(/\s/g, ''));
    if (flat.indexOf('직원ID') !== -1 && flat.indexOf('날짜') !== -1) { h = i; break; }
  }
  if (h >= 0) {
    const header = rows[h].map((c) => String(c || '').replace(/\s/g, ''));
    const col = (...ns) => { for (const nm of ns) { const i = header.indexOf(nm); if (i !== -1) return i; } return -1; };
    const cExt = col('직원ID', 'ID'), cDate = col('날짜'), cStart = col('예정출근', '출근'), cEnd = col('예정퇴근', '퇴근'), cOv = col('익일'), cKind = col('구분'), cBranch = col('지점', '지역', '재직장소'), cName = col('이름', '성명');
    const fmtDate = (v) => (v instanceof Date) ? ymd(v.getTime()) : String(v == null ? '' : v).trim();
    const hm = (v) => { if (v instanceof Date) return String(v.getHours()).padStart(2, '0') + ':' + String(v.getMinutes()).padStart(2, '0'); const m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/); return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : ''; };
    incoming = []; months = new Set(); exts = new Set();
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i]; if (!r) continue;
      const extId = cExt >= 0 ? String(r[cExt] == null ? '' : r[cExt]).trim() : '';
      const date = cDate >= 0 ? fmtDate(r[cDate]) : '';
      if (!extId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      incoming.push({ extId, date, name: cName >= 0 ? String(r[cName] == null ? '' : r[cName]).trim() : '', region: cBranch >= 0 ? String(r[cBranch] == null ? '' : r[cBranch]).trim() : '', start: cStart >= 0 ? hm(r[cStart]) : '', end: cEnd >= 0 ? hm(r[cEnd]) : '', overnight: cOv >= 0 && String(r[cOv]).trim().toUpperCase() === 'Y', kind: cKind >= 0 ? (String(r[cKind] == null ? '' : r[cKind]).trim() || '근무') : '근무' });
      months.add(date.slice(0, 7)); exts.add(extId);
    }
    if (!incoming.length) return { ok: false, error: '가져올 행이 없습니다(직원ID·날짜 확인).' };
  } else {
    // 2) 손으로 만든 근무표(범례+격자) 원본 — 시트를 추출해 calc로 파싱(이름→직원 매칭)
    const sheetGrids = {};
    for (const nm of wb.SheetNames) sheetGrids[nm] = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: '' });
    const gr = calc.parseGridSchedule(sheetGrids, path.basename(filePaths[0]), listEmployees());
    if (gr.error) return { ok: false, error: gr.error };
    incoming = gr.incoming; months = gr.months; exts = gr.exts; gridInfo = gr;
    if (!incoming.length) return { ok: false, error: '가져올 근무가 없습니다' + (gr.unmatched && gr.unmatched.length ? ' (이름 매칭 실패: ' + gr.unmatched.join(', ') + ')' : '(직원 이름을 확인하세요)') + '.' };
  }
  const coll = readColl('schedules');
  // 가져온 직원(extId)×달만 교체 — 지역별 분리 내보내기 대응: 평택 가져와도 속초 보존(통째 삭제 금지)
  coll.records = coll.records.filter((r) => !(r && months.has(String(r.date).slice(0, 7)) && exts.has(r.extId)));
  coll.records.push(...incoming);
  writeColl('schedules', coll);
  const regions = Array.from(new Set(incoming.map((r) => r.region).filter(Boolean)));
  audit('schedule.import', `근무표(예정) 가져오기 (${incoming.length}행, ${Array.from(months).join(',')}${regions.length ? ', ' + regions.join('·') : ''}${gridInfo ? ', 원본격자' : ''})`, { actorRole: 'admin' });
  // 이름↔직원ID 자동연결: extId 없는 직원을 근무표의 이름(+지역)으로 매칭해 extId 채움
  //  - 빈 extId만 채우고(기존 연결 보존), 이미 쓰인 extId는 건너뜀(동명이인 오연결 방지), 지역 불일치 시 제외
  const empColl = readColl('employees');
  const usedExt = new Set(empColl.records.map((e) => e.extId).filter(Boolean));
  const nameToExt = {};
  for (const r of incoming) { if (r.name && r.extId && !nameToExt[r.name]) nameToExt[r.name] = { extId: r.extId, region: r.region || '' }; }
  let linked = 0;
  for (const e of empColl.records) {
    if (e.extId) continue;
    const hit = nameToExt[e.name];
    if (hit && !usedExt.has(hit.extId) && (!e.region || !hit.region || e.region === hit.region)) {
      e.extId = hit.extId; e.updatedAt = Date.now(); usedExt.add(hit.extId); linked++;
    }
  }
  if (linked) { writeColl('employees', empColl); audit('schedule.autolink', `근무표 이름으로 직원ID 자동연결 ${linked}명`, { actorRole: 'admin' }); }
  const known = new Set(listEmployees().map((e) => e.extId).filter(Boolean));
  const matched = Array.from(exts).filter((x) => known.has(x)).length;
  const result = { ok: true, rows: incoming.length, months: Array.from(months), employees: exts.size, matched, regions, linked };
  if (gridInfo) { result.viaGrid = true; result.unmatched = gridInfo.unmatched || []; result.matchedNames = gridInfo.matched || []; }
  return result;
});
ipcMain.handle('schedule:status', () => {
  const coll = readColl('schedules');
  const byMonth = {};
  for (const r of coll.records) {
    if (!r || !r.date) continue;
    const m = String(r.date).slice(0, 7);
    const mm = (byMonth[m] = byMonth[m] || { emps: new Set(), regions: {} });
    mm.emps.add(r.extId);
    const rg = r.region || '미지정';
    (mm.regions[rg] = mm.regions[rg] || new Set()).add(r.extId);
  }
  const months = Object.keys(byMonth).sort().map((m) => ({
    month: m,
    employees: byMonth[m].emps.size,
    regions: Object.keys(byMonth[m].regions).sort().map((rg) => ({ region: rg, employees: byMonth[m].regions[rg].size }))
  }));
  return { ok: true, months, total: coll.records.length };
});
// 가져온 근무표(예정) 조회 — 직원×날짜 표로 보기 (직원명·근무형태 join, 미등록/고정 경고용)
ipcMain.handle('schedule:list', (_e, month) => {
  const g = requireAdmin(); if (g) return g;
  const coll = readColl('schedules');
  const byExt = {};
  for (const r of coll.records) {
    if (!r || !r.date) continue;
    if (month && String(r.date).slice(0, 7) !== month) continue;
    (byExt[r.extId] = byExt[r.extId] || []).push(r);
  }
  const toDays = (recs) => recs.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((r) => ({ date: r.date, kind: r.kind || '근무', start: r.start || '', end: r.end || '', overnight: !!r.overnight }));
  const allEmps = listEmployees();
  const emps = allEmps.filter((e) => e.active !== false && !e.excludeFromSchedule);
  const empExtAll = new Set(allEmps.map((e) => e.extId).filter(Boolean)); // 비활성·제외 포함 — 고아 판정용
  // 1) 모든 재직 직원 — 편성 없으면 빈 행(hasSchedule:false)으로도 표시(평택 외국인 등 누락 가시화)
  const rows = emps.map((e) => {
    const recs = (e.extId && byExt[e.extId]) || [];
    return { extId: e.extId || '', name: e.name, region: e.region || '미지정', matched: true, hasSchedule: recs.length > 0, scheduleType: e.scheduleType || 'fixed', days: toDays(recs) };
  });
  // 2) 직원명부에 없는 근무표(미등록 extId)도 표시
  Object.keys(byExt).forEach((extId) => {
    if (empExtAll.has(extId)) return; // 직원명부에 있으면(비활성 포함) 미등록 아님
    const recs = byExt[extId];
    const schedName = (recs.find((r) => r.name) || {}).name || '';
    rows.push({ extId, name: '(미등록 ' + (schedName || extId) + ')', schedName, region: (recs.find((r) => r.region) || {}).region || '미지정', matched: false, hasSchedule: true, scheduleType: '', days: toDays(recs) });
  });
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const unmatched = rows.filter((r) => !r.matched).length;
  const noSchedule = rows.filter((r) => r.matched && !r.hasSchedule).length;
  return { ok: true, month: month || '', rows, unmatched, noSchedule, total: rows.length };
});
// 근무표(예정) 삭제 — 선택 월(또는 전체) 삭제 후 변경분 재가져오기용
ipcMain.handle('schedule:clear', (_e, month) => {
  const g = requireAdmin(); if (g) return g;
  const coll = readColl('schedules');
  const before = coll.records.length;
  coll.records = month ? coll.records.filter((r) => String(r.date).slice(0, 7) !== month) : [];
  writeColl('schedules', coll);
  const removed = before - coll.records.length;
  audit('schedule.clear', `근무표 삭제 (${month || '전체'}, ${removed}건)`, { actorRole: 'admin' });
  return { ok: true, removed };
});
ipcMain.handle('punch:list', (_e, filter) => {
  const g = requireAdmin(); if (g) return g;
  return { ok: true, rows: listPunches(filter) };
});
ipcMain.handle('payroll:compute', (_e, month) => {
  const g = requireAdmin(); if (g) return g;
  const snap = getSnapshot(month);
  if (snap) return { ok: true, rows: snap.rows, closed: true, closedAt: snap.closedAt };
  return { ok: true, rows: computePayroll(month), closed: false };
});
ipcMain.handle('payroll:close', (_e, month) => {
  const g = requireAdmin(); if (g) return g;
  return closePayroll(month);
});
ipcMain.handle('payroll:reopen', (_e, month) => {
  const g = requireAdmin(); if (g) return g;
  return reopenPayroll(month);
});
ipcMain.handle('punch:detail', (_e, empId, workDate) => {
  const g = requireAdmin(); if (g) return g;
  const emp = getEmployee(empId);
  return { ok: true, name: emp ? emp.name : '', workDate, closed: isMonthClosed(String(workDate || '').slice(0, 7)), punches: punchDetail(empId, workDate) };
});
ipcMain.handle('punch:correct', (_e, p) => {
  const g = requireAdmin(); if (g) return g;
  return addCorrection(p || {});
});
ipcMain.handle('punch:bulkTemplate', async (_e, start, end) => {
  const g = requireAdmin(); if (g) return g;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) return { ok: false, error: '시작/종료일이 올바르지 않습니다.' };
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '점각 일괄등록 양식 저장',
    defaultPath: `점각일괄등록_${start}_${end}.xlsx`,
    filters: [{ name: '엑셀', extensions: ['xlsx'] }]
  });
  if (canceled || !filePath) return { ok: false };
  try { return Object.assign({ ok: true, filePath }, bulkTemplateXlsx(start, end, filePath)); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('punch:bulkImport', async () => {
  const g = requireAdmin(); if (g) return g;
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '채운 점각 일괄등록 양식 선택', properties: ['openFile'],
    filters: [{ name: '엑셀', extensions: ['xlsx', 'xls'] }]
  });
  if (canceled || !filePaths.length) return { ok: false, error: '취소되었습니다.' };
  return bulkImportPunches(filePaths[0]);
});
ipcMain.handle('payroll:export', async (_e, month) => {
  const g = requireAdmin(); if (g) return g;
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '근태·수당 집계 엑셀 저장 (운영관리로 가져갈 파일)',
    defaultPath: `근태_${month}.xlsx`,
    filters: [{ name: '엑셀', extensions: ['xlsx'] }]
  });
  if (canceled || !filePath) return { ok: false };
  const n = exportPayrollXlsx(month, filePath);
  audit('payroll.export', `근태집계 엑셀 내보내기 ${month} (${n}명)`, { actorRole: 'admin' });
  return { ok: true, filePath, count: n };
});
ipcMain.handle('holidays:get', () => {
  const g = requireAdmin(); if (g) return g;
  return { ok: true, holidays: readColl('holidays').records.slice().sort((a, b) => a.date.localeCompare(b.date)) };
});
ipcMain.handle('holidays:save', (_e, list) => {
  const g = requireAdmin(); if (g) return g;
  const clean = (Array.isArray(list) ? list : [])
    .filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
    .map((h) => ({ date: h.date, name: String(h.name || '').slice(0, 40), type: h.type || 'public' }));
  writeColl('holidays', { version: SCHEMA_VERSION, records: clean });
  audit('holidays.save', `공휴일 ${clean.length}건 저장`, { actorRole: 'admin' });
  return { ok: true };
});
ipcMain.handle('settings:update', (_e, partial) => {
  const g = requireAdmin(); if (g) return g;
  const allowed = ['businessName', 'fiveOrMore', 'cancelWindowSec', 'kioskLock', 'backup'];
  for (const k of allowed) if (k in partial) SETTINGS[k] = partial[k];
  saveSettings();
  applyKioskLock();
  audit('settings.update', '설정 변경', { actorRole: 'admin' });
  return { ok: true };
});
ipcMain.handle('backup:run', () => {
  const g = requireAdmin(); if (g) return g;
  const r = runBackup('manual');
  audit('backup.run', '수동 백업', { actorRole: 'admin' });
  return r;
});
ipcMain.handle('integrity:check', () => {
  const g = requireAdmin(); if (g) return g;
  return { ok: true, punches: verifyChain('punches'), corrections: verifyChain('corrections'), auditLog: verifyChain('auditLog') };
});
ipcMain.handle('data:openFolder', () => { shell.openPath(DATA_DIR); return { ok: true }; });
ipcMain.handle('backup:openFolder', () => { shell.openPath(BACKUP_DIR); return { ok: true }; });
ipcMain.handle('app:dataDir', () => USER_DIR);

// ---------------------------------------------------------------------------
// 윈도우 / 키오스크 잠금
// ---------------------------------------------------------------------------
let mainWindow = null;

function applyKioskLock() {
  if (!mainWindow) return;
  const lock = !!SETTINGS.kioskLock;
  mainWindow.setKiosk(lock);
  if (lock) {
    // 흔한 탈출/종료 키 차단 (관리자 화면에서 해제 가능)
    globalShortcut.register('Alt+F4', () => {});
    globalShortcut.register('CommandOrControl+W', () => {});
    globalShortcut.register('CommandOrControl+R', () => {});
    globalShortcut.register('F11', () => {});
  } else {
    globalShortcut.unregisterAll();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: '출퇴근 점각',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 진단 로깅: 렌더러 콘솔/오류를 메인 stdout 으로 출력
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('preload-error', (_e, p, error) => {
    console.log('[preload-error]', p, error && error.stack ? error.stack : error);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[did-fail-load]', code, desc, url);
  });
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    console.log('[render-gone]', JSON.stringify(d));
  });

  // 키오스크 잠금 중에는 닫기 차단(관리자 해제 후 종료)
  mainWindow.on('close', (e) => {
    if (SETTINGS.kioskLock && !adminOk()) {
      e.preventDefault();
      mainWindow.webContents.send('kiosk:blockedClose');
    }
  });

  mainWindow.webContents.on('did-finish-load', () => applyKioskLock());
}

// 단일 인스턴스 — 공용 PC에서 중복 실행 방지(캐시 충돌·데이터 경합·이중 점각 차단)
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    initData();
    loadSettings();
    runBackup('startup');
    startBackupTimer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
