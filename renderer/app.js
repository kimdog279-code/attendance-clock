'use strict';

// ===========================================================================
//  렌더러 — 키오스크(점각) + 관리자
// ===========================================================================
// 전체를 IIFE로 감싼다. 전역 스코프에서 const api 를 선언하면 contextBridge가
// 만든 비구성 전역 'api' 와 충돌해 SyntaxError 가 나기 때문(→ 화면 클릭 전부 무반응).
// 함수 스코프 안에서는 충돌하지 않는다.
(function () {
const $ = (id) => document.getElementById(id);
const api = window.api || {};

// 진단: 렌더러 오류를 화면 하단 배너 + 콘솔에 표시
function showFatal(msg) {
  console.error('[apperror]', msg);
  let b = document.getElementById('__err');
  if (!b) {
    b = document.createElement('div');
    b.id = '__err';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#dc2626;color:#fff;padding:10px 14px;font:13px monospace;z-index:99999;white-space:pre-wrap;max-height:45vh;overflow:auto';
    document.body.appendChild(b);
  }
  b.textContent = '오류: ' + msg;
}
window.addEventListener('error', (e) => showFatal((e.error && e.error.stack) || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal('Promise: ' + ((e.reason && e.reason.stack) || e.reason)));

const S = {
  settings: null,
  employees: [],          // 키오스크 공개목록
  cur: { empId: null, name: '', pin: '' }, // 점각 진행중 임시
  lastPunch: null,        // { id, type, ts }
  fails: {},              // empId -> { count, lockUntil }
  doneTimer: null,
  empsFull: []            // 관리자 직원목록
};

// ---------- 공통 유틸 ----------
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function hm(ts) { if (!ts) return '—'; const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function minToHhmm(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60), m = min % 60;
  return (h ? h + '시간 ' : '') + (m ? m + '분' : (h ? '' : '0분'));
}
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// ---------- 시계 ----------
function tickClock() {
  const d = new Date();
  $('clockTime').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  $('clockDate').textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
}

// ===========================================================================
//  키오스크
// ===========================================================================
async function loadKiosk() {
  S.settings = await api.getSettings();
  $('bizName').textContent = S.settings.businessName || '우리 호텔';
  $('adminBiz').textContent = S.settings.businessName || '우리 호텔';
  S.employees = await api.listEmployeesPublic();
  renderEmpGrid();
}

// 이름 기반 결정적 아바타 색(그라데이션)
const AVATAR_COLORS = [
  ['#6366f1', '#4f46e5'], ['#0ea5e9', '#0284c7'], ['#14b8a6', '#0d9488'],
  ['#f59e0b', '#d97706'], ['#f43f5e', '#e11d48'], ['#8b5cf6', '#7c3aed'],
  ['#ec4899', '#db2777'], ['#10b981', '#059669'], ['#f97316', '#ea580c'],
  ['#3b82f6', '#2563eb'], ['#06b6d4', '#0891b2'], ['#a855f7', '#9333ea']
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
// "DYO ...(슬라브)" → { main:"DYO ...", sub:"슬라브" } / 괄호 없으면 sub 빈값
function splitName(full) {
  const m = String(full || '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m && m[2]) return { main: m[1].trim() || m[2].trim(), sub: m[2].trim() };
  return { main: String(full || '').trim(), sub: '' };
}

function renderEmpGrid() {
  const grid = $('empGrid');
  if (!S.employees.length) { grid.innerHTML = ''; show('empEmpty'); return; }
  hide('empEmpty');
  grid.innerHTML = S.employees.map((e) => {
    const working = e.status && e.status.state === 'working';
    const { main, sub } = splitName(e.name);
    const initial = main[0] || e.name[0] || '?';
    const [c1, c2] = avatarColor(e.name);
    return `<div class="emp-tile ${working ? 'working' : ''}" data-id="${e.id}">
      ${working ? '<span class="emp-status"><span class="dot"></span>근무중</span>' : ''}
      <span class="emp-avatar" style="background:linear-gradient(135deg,${c1},${c2})">${escapeHtml(initial)}</span>
      <span class="emp-name">${escapeHtml(main)}</span>
      ${sub ? `<span class="emp-sub">${escapeHtml(sub)}</span>` : ''}
    </div>`;
  }).join('');
  grid.querySelectorAll('.emp-tile').forEach((el) => {
    el.addEventListener('click', () => openPin(el.dataset.id));
  });
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- PIN ----------
function openPin(empId) {
  const emp = S.employees.find((e) => e.id === empId);
  if (!emp) return;
  const f = S.fails[empId];
  if (f && f.lockUntil && Date.now() < f.lockUntil) {
    const sec = Math.ceil((f.lockUntil - Date.now()) / 1000);
    toast(`PIN 5회 오류로 잠금되었습니다. ${sec}초 후 다시 시도하세요.`, 'bad');
    return;
  }
  S.cur = { empId, name: emp.name, pin: '' };
  $('pinName').textContent = emp.name;
  $('pinError').textContent = '';
  renderPinDots();
  buildKeypad();
  show('pinOverlay');
}

function renderPinDots() {
  const n = S.cur.pin.length;
  $('pinDots').innerHTML = [0, 1, 2, 3].map((i) => `<div class="dot ${i < n ? 'on' : ''}"></div>`).join('');
}

function buildKeypad() {
  const kp = $('keypad');
  if (kp._built) return;
  const cells = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'blank'];
  kp.innerHTML = cells.map((c) => {
    if (c === 'blank') return '<div></div>';
    if (c === 'back') return '<button class="back" data-k="back">⌫</button>';
    return `<button class="${c === '0' ? 'zero' : ''}" data-k="${c}">${c}</button>`;
  }).join('');
  kp.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => pinKey(b.dataset.k)));
  kp._built = true;
}

async function pinKey(k) {
  if (k === 'back') { S.cur.pin = S.cur.pin.slice(0, -1); renderPinDots(); return; }
  if (S.cur.pin.length >= 4) return;
  S.cur.pin += k;
  renderPinDots();
  if (S.cur.pin.length === 4) {
    const res = await api.verifyPin(S.cur.empId, S.cur.pin);
    if (res && res.ok) {
      delete S.fails[S.cur.empId];
      hide('pinOverlay');
      openAction(res.status);
    } else {
      const f = S.fails[S.cur.empId] || { count: 0 };
      f.count += 1;
      if (f.count >= 5) { f.lockUntil = Date.now() + 60000; S.fails[S.cur.empId] = f; hide('pinOverlay'); toast('PIN 5회 오류 — 60초 잠금', 'bad'); return; }
      S.fails[S.cur.empId] = f;
      $('pinError').textContent = (res && res.error ? res.error : 'PIN이 맞지 않습니다.') + ` (${f.count}/5)`;
      S.cur.pin = '';
      renderPinDots();
      shake($('pinDots'));
    }
  }
}

function shake(el) { el.style.animation = 'none'; void el.offsetWidth; el.style.transition = 'transform .07s'; let i = 0; const seq = [-8, 8, -6, 6, 0]; const run = () => { el.style.transform = `translateX(${seq[i]}px)`; if (++i < seq.length) setTimeout(run, 60); }; run(); }

// ---------- 출근/퇴근 ----------
function openAction(status) {
  $('actionName').textContent = S.cur.name;
  let txt = '';
  if (status.state === 'working') txt = `근무중 (출근 ${hm(status.openSince)})`;
  else if (status.lastOut) txt = `마지막 퇴근 ${hm(status.lastOut)}`;
  else txt = '오늘 출근 기록이 없습니다';
  $('actionStatus').textContent = txt;
  $('btnIn').disabled = !status.canIn;
  $('btnOut').disabled = !status.canOut;
  show('actionOverlay');
}

async function doPunch(type) {
  const res = await api.punch(S.cur.empId, S.cur.pin, type);
  hide('actionOverlay');
  if (!res || !res.ok) { toast(res && res.error ? res.error : '처리 실패', 'bad'); resetCur(); await refreshGrid(); return; }
  S.lastPunch = res.record;
  showDone(type, res.record.ts, res.canCancelUntilMs);
  await refreshGrid();
}

function showDone(type, ts, cancelMs) {
  const card = document.querySelector('#doneOverlay .done-card');
  card.classList.toggle('out', type === 'out');
  $('doneIcon').textContent = '✓';
  $('doneTitle').textContent = type === 'in' ? '출근 완료' : '퇴근 완료';
  $('doneTime').textContent = hm(ts);
  $('doneName').textContent = S.cur.name + ' 님';
  show('doneOverlay');
  // 취소 카운트다운
  let remain = Math.ceil((cancelMs || 60000) / 1000);
  const btn = $('btnCancelPunch');
  btn.disabled = false;
  const upd = () => {
    $('cancelCount').textContent = `(${remain}s)`;
    if (remain <= 0) { btn.disabled = true; $('cancelCount').textContent = ''; closeDone(); return; }
    remain -= 1;
  };
  upd();
  clearInterval(S.doneTimer);
  S.doneTimer = setInterval(upd, 1000);
}

async function cancelLastPunch() {
  if (!S.lastPunch) return;
  const res = await api.cancelPunch(S.lastPunch.id, S.cur.empId, S.cur.pin);
  if (res && res.ok) { toast('방금 점각을 취소했습니다.', 'good'); }
  else { toast(res && res.error ? res.error : '취소 실패', 'bad'); }
  closeDone();
  await refreshGrid();
}

function closeDone() {
  clearInterval(S.doneTimer);
  hide('doneOverlay');
  resetCur();
}
function resetCur() { S.cur = { empId: null, name: '', pin: '' }; S.lastPunch = null; }

async function refreshGrid() { S.employees = await api.listEmployeesPublic(); renderEmpGrid(); }

// ===========================================================================
//  관리자
// ===========================================================================
let gateMode = 'login';

async function openAdmin() {
  hide('kiosk'); show('admin');
  const st = await api.adminStatus();
  if (!st.adminIsSet) { gateMode = 'set'; showGate(); }
  else if (!st.unlocked) { gateMode = 'login'; showGate(); }
  else { showPanels(); }
}

function showGate() {
  hide('adminPanels'); show('adminGate');
  $('gateError').textContent = '';
  $('gatePw').value = ''; $('gatePw2').value = '';
  if (gateMode === 'set') {
    $('gateTitle').textContent = '관리자 비밀번호 설정';
    $('gateSub').textContent = '처음 사용입니다. 관리자 비밀번호를 정하세요 (4자 이상).';
    show('gatePw2');
    $('gateCancel').textContent = '점각화면으로';
  } else if (gateMode === 'change') {
    $('gateTitle').textContent = '관리자 비밀번호 변경';
    $('gateSub').textContent = '새 비밀번호를 입력하세요 (4자 이상).';
    show('gatePw2');
    $('gateCancel').textContent = '취소';
  } else {
    $('gateTitle').textContent = '관리자 로그인';
    $('gateSub').textContent = '비밀번호를 입력하세요';
    hide('gatePw2');
    $('gateCancel').textContent = '점각화면으로';
  }
  setTimeout(() => $('gatePw').focus(), 50);
}

async function submitGate() {
  const pw = $('gatePw').value;
  if (gateMode === 'login') {
    const res = await api.adminVerify(pw);
    if (res.ok) showPanels(); else $('gateError').textContent = res.error || '비밀번호가 맞지 않습니다.';
    return;
  }
  // set / change
  const pw2 = $('gatePw2').value;
  if (pw.length < 4) { $('gateError').textContent = '4자 이상 입력하세요.'; return; }
  if (pw !== pw2) { $('gateError').textContent = '비밀번호 확인이 일치하지 않습니다.'; return; }
  const res = await api.adminSetPassword(pw);
  if (res.ok) { toast('비밀번호가 설정되었습니다.', 'good'); if (gateMode === 'change') showPanels(); else showPanels(); }
  else $('gateError').textContent = res.error || '설정 실패';
}

function gateCancel() {
  if (gateMode === 'change') { showPanels(); return; }
  backToKiosk();
}

async function showPanels() {
  hide('adminGate'); show('adminPanels');
  switchTab('emp');
  await loadEmployeesAdmin();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['emp', 'punch', 'pay', 'settings'].forEach((n) => $('tab-' + n).classList.toggle('hidden', n !== name));
  if (name === 'punch') initPunchTab();
  if (name === 'pay') initPayTab();
  if (name === 'settings') loadSettingsTab();
}

async function backToKiosk() {
  await api.adminLock();
  hide('admin'); show('kiosk');
  await loadKiosk();
}

// ---------- 직원관리 ----------
async function loadEmployeesAdmin() {
  const res = await api.listEmployeesFull();
  if (!res.ok) { toast(res.error || '불러오기 실패', 'bad'); return; }
  S.empsFull = res.employees;
  renderEmpTable();
}

function payLabel(e) {
  if (e.payType === 'monthly') return e.wage && e.wage.monthlySalary ? (e.wage.monthlySalary).toLocaleString() + '원/월' : '월급';
  return e.wage && e.wage.hourlyRate ? (e.wage.hourlyRate).toLocaleString() + '원/시' : '시급';
}

function renderEmpTable() {
  const tb = $('empTbody');
  if (!S.empsFull.length) { tb.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:24px">등록된 직원이 없습니다. “운영관리에서 직원 가져오기” 또는 “+ 직원 등록”으로 시작하세요.</td></tr>'; return; }
  tb.innerHTML = S.empsFull.map((e) => `<tr>
    <td><b>${escapeHtml(e.name)}</b>${e.extId ? ' <span class="tag warn">운영관리</span>' : ''}</td>
    <td>${escapeHtml(e.empNo || '')}</td>
    <td>${escapeHtml(e.region || '')}</td>
    <td>${e.payType === 'monthly' ? '월급제' : '시급제'}</td>
    <td>${escapeHtml(payLabel(e))}</td>
    <td>${e.scheduleType === 'shift' ? '교대' : '고정'}</td>
    <td>${e.pinSet ? '<span class="tag on">설정됨</span>' : '<span class="tag off">미설정</span>'}</td>
    <td>${e.active === false ? '<span class="tag off">퇴사</span>' : '<span class="tag on">재직</span>'}</td>
    <td><span class="row-link" data-edit="${e.id}">수정</span> · <span class="row-link danger" data-del="${e.id}" data-name="${escapeHtml(e.name)}">삭제</span></td>
  </tr>`).join('');
  tb.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', () => openEmpModal(S.empsFull.find((x) => x.id === el.dataset.edit))));
  tb.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => delEmp(el.dataset.del, el.dataset.name)));
}

function openEmpModal(emp) {
  const isNew = !emp;
  $('empModalTitle').textContent = isNew ? '직원 등록' : '직원 수정';
  $('empModalError').textContent = '';
  const g = (id, v) => { $(id).value = v == null ? '' : v; };
  g('em_name', emp ? emp.name : '');
  g('em_empNo', emp ? emp.empNo : '');
  g('em_region', emp ? emp.region : '');
  g('em_dept', emp ? emp.dept : '');
  $('em_payType').value = emp && emp.payType ? emp.payType : 'hourly';
  g('em_hourly', emp && emp.wage ? emp.wage.hourlyRate : '');
  g('em_monthly', emp && emp.wage ? emp.wage.monthlySalary : '');
  $('em_schedType').value = emp && emp.scheduleType ? emp.scheduleType : 'fixed';
  g('em_start', emp && emp.shiftStart ? emp.shiftStart : '09:00');
  g('em_end', emp && emp.shiftEnd ? emp.shiftEnd : '18:00');
  g('em_break', emp && emp.breakMinutes != null ? emp.breakMinutes : 60);
  setWorkdays(emp && Array.isArray(emp.workDays) ? emp.workDays : [1, 2, 3, 4, 5]);
  $('em_exclSched').checked = !!(emp && emp.excludeFromSchedule);
  g('em_pin', emp ? '' : '1234');
  togglePayType();
  toggleSchedType();
  // PIN 필수/선택 표시
  if (isNew) { hide('em_pinNote'); $('lbl_pin').querySelector('input').placeholder = '신규 등록 시 필수'; hide('btnDeactivate'); }
  else { show('em_pinNote'); $('lbl_pin').querySelector('input').placeholder = '변경 시에만 입력'; $('btnDeactivate').classList.toggle('hidden', emp.active === false); }
  $('empModal').dataset.id = emp ? emp.id : '';
  show('empModal');
}

function togglePayType() {
  const t = $('em_payType').value;
  $('lbl_hourly').classList.toggle('hidden', t !== 'hourly');
  $('lbl_monthly').classList.toggle('hidden', t !== 'monthly');
}
// 교대 근무형태면 소정시각·근무요일은 근무표(편성)가 대체 → 숨기고 안내. 고정이면 표시.
function toggleSchedType() {
  const shift = $('em_schedType').value === 'shift';
  $('lbl_workdays').classList.toggle('hidden', shift);
  $('lbl_shift').classList.toggle('hidden', shift);
  $('schedNote').classList.toggle('hidden', !shift);
}

async function saveEmp() {
  const id = $('empModal').dataset.id;
  const name = $('em_name').value.trim();
  if (!name) { $('empModalError').textContent = '이름을 입력하세요.'; return; }
  const pin = $('em_pin').value.trim();
  if (!id && !/^\d{4}$/.test(pin)) { $('empModalError').textContent = '신규 등록은 PIN 숫자 4자리가 필요합니다.'; return; }
  if (pin && !/^\d{4}$/.test(pin)) { $('empModalError').textContent = 'PIN은 숫자 4자리여야 합니다.'; return; }

  const payType = $('em_payType').value;
  const emp = {
    name,
    empNo: $('em_empNo').value.trim(),
    region: $('em_region').value.trim(),
    dept: $('em_dept').value.trim(),
    payType,
    wage: {
      hourlyRate: Number($('em_hourly').value) || 0,
      monthlySalary: Number($('em_monthly').value) || 0,
      monthlyContractHours: 209
    },
    scheduleType: $('em_schedType').value,
    shiftStart: $('em_start').value,
    shiftEnd: $('em_end').value,
    breakMinutes: Number($('em_break').value) || 0,
    workDays: getWorkdays(),
    excludeFromSchedule: $('em_exclSched').checked
  };
  let res;
  if (id) {
    emp.id = id;
    res = await api.saveEmployee(emp);
    if (res.ok && pin) await api.setEmployeePin(id, pin);
  } else {
    emp._pin = pin;
    res = await api.saveEmployee(emp);
  }
  if (!res.ok) { $('empModalError').textContent = res.error || '저장 실패'; return; }
  hide('empModal');
  toast('저장되었습니다.', 'good');
  await loadEmployeesAdmin();
}

async function deactivateEmp() {
  const id = $('empModal').dataset.id;
  if (!id) return;
  const res = await api.deactivateEmployee(id);
  if (res.ok) { hide('empModal'); toast('퇴사 처리되었습니다.', 'good'); await loadEmployeesAdmin(); }
  else toast(res.error || '실패', 'bad');
}

async function delEmp(id, name) {
  if (!window.confirm(`'${name}' 직원을 삭제할까요?\n\n점각 기록이 있으면 삭제되지 않고 [퇴사 처리]를 안내합니다.\n(이력 보존을 위해 권장)`)) return;
  const res = await api.deleteEmployee(id);
  if (res.ok) { toast('삭제되었습니다.', 'good'); await loadEmployeesAdmin(); }
  else toast(res.error || '삭제 실패', 'bad');
}

async function importRoster() {
  const res = await api.importRoster();
  if (!res || !res.ok) { if (res && res.error && res.error !== '취소되었습니다.') toast(res.error, 'bad'); return; }
  toast(`신규 ${res.imported}명 등록${res.imported ? ' (초기 PIN 1234)' : ''} · 기존 ${res.skipped || 0}명 제외`, 'good');
  await loadEmployeesAdmin();
}

// ---------- 점각기록 ----------
let punchInit = false;
function initPunchTab() {
  if (!punchInit) {
    const d = new Date();
    $('filterMonth').value = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    const sel = $('filterEmp');
    sel.innerHTML = '<option value="">전체</option>' + S.empsFull.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
    $('bulkStart').value = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-01';
    $('bulkEnd').value = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    punchInit = true;
  }
  loadPunches();
}

// 과거 점각 일괄등록 — 양식 내보내기 / 작성본 가져오기
async function bulkTemplate() {
  const s = $('bulkStart').value, e = $('bulkEnd').value;
  if (!s || !e) { toast('시작/종료일을 선택하세요', 'bad'); return; }
  if (s > e) { toast('종료일이 시작일보다 빠릅니다', 'bad'); return; }
  const res = await api.bulkTemplate(s, e);
  if (res && res.ok) toast(`양식 저장됨 — 직원별 탭 ${res.employees}개 × ${res.dates}일. 각 탭에서 출근·퇴근만 채워 올리세요.`, 'good');
  else if (res && res.error && res.error !== '취소되었습니다.') toast(res.error, 'bad');
}
async function bulkImport() {
  if (!window.confirm('작성한 점각 양식을 가져올까요?\n이미 등록된 출근/퇴근은 건너뜁니다(중복 방지).')) return;
  const res = await api.bulkImport();
  if (!res || !res.ok) { if (res && res.error && res.error !== '취소되었습니다.') toast(res.error, 'bad'); return; }
  toast(`일괄등록 — 추가 ${res.added}건, 건너뜀 ${res.skipped}건${res.errorCount ? `, 오류 ${res.errorCount}건` : ''}`, res.errorCount ? 'bad' : 'good');
  if (res.errorCount && res.errors && res.errors.length) window.alert('일부 행 오류 (' + res.errorCount + '건):\n' + res.errors.join('\n'));
  await loadPunches();
}

async function loadPunches() {
  const res = await api.listPunches({ month: $('filterMonth').value, empId: $('filterEmp').value });
  if (!res.ok) { toast(res.error || '조회 실패', 'bad'); return; }
  const tb = $('punchTbody');
  if (!res.rows.length) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px">해당 월 점각 기록이 없습니다.</td></tr>'; return; }
  tb.innerHTML = res.rows.map((r) => `<tr>
    <td>${r.workDate}</td>
    <td>${escapeHtml(r.empName)}</td>
    <td>${hm(r.firstIn)}</td>
    <td>${r.missingOut ? '<span class="tag warn">미퇴근</span>' : hm(r.lastOut)}</td>
    <td>${r.grossMinutes != null ? minToHhmm(r.grossMinutes) : '—'}</td>
    <td>${escapeHtml(r.flags || '')}</td>
    <td><span class="row-link" data-cid="${r.empId}" data-cwd="${r.workDate}" data-cnm="${escapeHtml(r.empName)}">보정</span></td>
  </tr>`).join('');
  tb.querySelectorAll('[data-cid]').forEach((el) => el.addEventListener('click', () => openCorrect(el.dataset.cid, el.dataset.cnm, el.dataset.cwd)));
}

// ---------- 설정 ----------
async function loadSettingsTab() {
  const s = await api.getSettings();
  $('setBiz').value = s.businessName || '';
  $('setFive').value = String(!!s.fiveOrMore);
  $('setCancel').value = s.cancelWindowSec != null ? s.cancelWindowSec : 60;
  $('setKiosk').checked = !!s.kioskLock;
  $('integrityResult').innerHTML = '';
  loadHolidays();
}

async function saveSettings() {
  const res = await api.updateSettings({
    businessName: $('setBiz').value.trim(),
    fiveOrMore: $('setFive').value === 'true',
    cancelWindowSec: Number($('setCancel').value) || 60,
    kioskLock: $('setKiosk').checked
  });
  if (res.ok) toast('설정이 저장되었습니다.', 'good'); else toast(res.error || '실패', 'bad');
}

async function runIntegrity() {
  const res = await api.integrityCheck();
  if (!res.ok) { toast(res.error || '실패', 'bad'); return; }
  const line = (name, r) => `<div>${name}: ${r.ok ? `<span class="ok">정상 (${r.total}건)</span>` : `<span class="bad">⚠ ${r.brokenAt}번째에서 위변조 의심</span>`}</div>`;
  $('integrityResult').innerHTML = line('점각기록', res.punches) + line('보정이력', res.corrections) + line('감사로그', res.auditLog);
}

// ---------- 근무요일 ----------
function setWorkdays(arr) {
  document.querySelectorAll('#em_workdays input[data-wd]').forEach((el) => { el.checked = arr.indexOf(Number(el.dataset.wd)) !== -1; });
}
function getWorkdays() {
  return Array.from(document.querySelectorAll('#em_workdays input[data-wd]:checked')).map((el) => Number(el.dataset.wd));
}

// ---------- 급여 집계 ----------
let payInit = false;
function initPayTab() {
  if (!payInit) { const d = new Date(); $('payMonth').value = d.getFullYear() + '-' + pad2(d.getMonth() + 1); payInit = true; }
  loadScheduleStatus();
  loadPayroll();
  viewSchedule(); // 선택 월의 근무표를 바로 표시
}
async function loadScheduleStatus() {
  const el = $('schedStatus'); if (!el) return;
  const res = await api.scheduleStatus();
  if (!res || !res.ok || !res.months || !res.months.length) {
    el.innerHTML = '⚠ 근무표(예정) 미반영 — 교대직의 결근·지각·조퇴는 운영관리에서 <b>‘점각용 근무표’</b>를 내보내 여기서 가져와야 판정됩니다.';
    return;
  }
  el.innerHTML = '근무표(예정) 반영됨: ' + res.months.map((m) => `<b>${m.month}</b> ${m.regions && m.regions.length ? m.regions.map((rg) => `${rg.region} ${rg.employees}명`).join(' · ') : m.employees + '명'}`).join(' / ');
}
async function importSchedule() {
  const res = await api.importSchedule();
  if (!res || !res.ok) { if (res && res.error && res.error !== '취소되었습니다.') toast(res.error, 'bad'); return; }
  toast(`근무표 가져오기 — ${(res.regions || []).length ? (res.regions.join('·') + ' · ') : ''}${res.rows}행 · ${(res.months || []).join(',')} · 매칭 ${res.matched}/${res.employees}명${res.linked ? ` · 직원ID 자동연결 ${res.linked}명` : ''}${res.viaGrid ? ' · 원본근무표 직접인식' : ''}`, 'good');
  if (res.viaGrid && res.unmatched && res.unmatched.length) toast(`⚠ 이름이 직원명부와 안 맞아 제외된 ${res.unmatched.length}명: ${res.unmatched.join(', ')} (외국인 고정근무자는 무시해도 됩니다)`, 'bad');
  if (res.matched === 0) toast('⚠ 직원ID가 일치하는 직원이 없습니다 — 먼저 ‘직원 엑셀 가져오기’로 직원을 맞춰주세요', 'bad');
  await loadScheduleStatus();
  await viewSchedule();
  loadPayroll();
}
// 가져온 근무표(예정)를 직원×날짜 표로 — 근무예정시간 확인용. 고정형태/미등록은 경고 표시.
async function viewSchedule() {
  const box = $('schedView'); if (!box) return;
  const month = $('payMonth').value;
  const res = await api.scheduleList(month);
  if (!res || !res.ok || !res.rows || !res.rows.length) {
    box.innerHTML = `<div class="hint">${month}에 가져온 근무표가 없습니다. ‘📥 근무표(예정) 가져오기’ 먼저 하세요.</div>`;
    return;
  }
  const wdName = (ds) => ['일', '월', '화', '수', '목', '금', '토'][new Date(ds + 'T00:00:00').getDay()];
  const dates = Array.from(new Set(res.rows.flatMap((r) => r.days.map((d) => d.date)))).sort();
  if (!dates.length) { box.innerHTML = `<div class="hint">${month}에 가져온 근무표가 없습니다. ‘📥 근무표(예정) 가져오기’ 먼저 하세요.</div>`; return; }
  const head = '<th style="text-align:left;position:sticky;left:0;background:#f8fafc">직원</th>' +
    dates.map((ds) => { const w = wdName(ds); const we = (w === '토' || w === '일'); return `<th style="${we ? 'color:#c0352b;' : ''}min-width:54px">${Number(ds.slice(8))}<br><span style="font-size:10px;color:#94a3b8">${w}</span></th>`; }).join('');
  const cell = (d) => {
    if (!d) return '<td style="color:#cbd5e1">·</td>';
    if (d.kind === '근무') { const t = d.start ? (d.start + (d.overnight ? '~익' + d.end : '~' + d.end)) : '근무'; return `<td style="background:#eff6ff;color:#1d4ed8;font-size:11px" title="${t}">${t}</td>`; }
    if (d.kind === '휴무') return '<td style="color:#94a3b8">휴</td>';
    if (d.kind === '연차') return '<td style="background:#fef3c7;color:#b45309">연</td>';
    if (d.kind === '연속') return '<td style="color:#a78bda" title="전일 야간 연속">↳</td>';
    return `<td>${escapeHtml(d.kind)}</td>`;
  };
  const rowHtml = (r) => {
    const map = {}; r.days.forEach((d) => { map[d.date] = d; });
    const warn = !r.matched ? ' <span class="tag off">미등록</span>'
      : !r.hasSchedule ? ' <span class="tag warn">근무표 없음</span>'
      : (r.scheduleType !== 'shift' ? ' <span class="tag warn" title="근무형태가 ‘고정’이라 이 근무표가 적용되지 않습니다. 직원관리에서 ‘교대’로 바꾸세요.">고정·미적용</span>' : ' <span class="tag" style="background:#dcfce7;color:#166534">교대</span>');
    const cells = dates.map((ds) => cell(map[ds])).join('');
    return `<tr><td style="text-align:left;white-space:nowrap;position:sticky;left:0;background:#fff"><b>${escapeHtml(r.name)}</b>${warn}</td>${cells}</tr>`;
  };
  const grp = {}; res.rows.forEach((r) => { const rg = r.region || '미지정'; (grp[rg] = grp[rg] || []).push(r); });
  const body = Object.keys(grp).sort((a, b) => a.localeCompare(b, 'ko')).map((rg) =>
    `<tr class="region-row"><td colspan="${dates.length + 1}">📍 ${escapeHtml(rg)} · ${grp[rg].length}명</td></tr>` + grp[rg].map(rowHtml).join('')
  ).join('');
  const banner = res.unmatched ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:11px 13px;margin-bottom:8px;font-size:13px;line-height:1.65">
    ⚠ <b>미등록 ${res.unmatched}명</b> — 직원ID가 연결되지 않아 이 직원들의 근무표는 급여 계산에 반영되지 않습니다.<br>
    <b>해결:</b> 운영관리 <b>직원 명부</b> 화면에서 <b>‘📤 직원명부(점각용)’</b> 으로 파일을 내보낸 뒤, 점각앱 <b>직원관리 → ‘직원 엑셀 가져오기’</b> 로 그 파일을 가져오세요. 직원ID가 들어와 자동 연결됩니다(PIN·근무형태 보존). <b>※‘급여근거’ 파일은 직원ID가 없어 연결되지 않습니다.</b></div>` : '';
  box.innerHTML = banner + `<div style="overflow:auto;max-height:52vh;border:1px solid #e2e8f0;border-radius:8px">
    <table class="data-table" style="font-size:12px;border-collapse:separate;border-spacing:0">
      <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="hint" style="margin-top:6px">파란칸=근무(예정 출퇴근), 휴=휴무, 연=연차, ↳=전일 야간연속. <b style="color:#b45309">‘고정·미적용’</b>=직원관리에서 근무형태를 <b>교대</b>로 바꿔야 이 근무표가 반영됩니다. <b style="color:#b91c1c">‘근무표 없음’</b>=이 달 편성이 없는 직원 — 교대 근무자라면 운영관리 편성표에 넣어 다시 내보내/가져오세요(고정 근무자는 소정시각으로 계산되어 편성 없어도 됩니다).</div>`;
}
// 근무표(예정) 삭제 — 선택 월. 변경 시 삭제 후 다시 가져오기.
async function clearSchedule() {
  const m = $('payMonth').value;
  if (!window.confirm(`${m} 근무표(예정)를 삭제할까요?\n삭제 후, 변경된 근무표를 다시 가져오면 됩니다.`)) return;
  const res = await api.clearSchedule(m);
  if (!res || !res.ok) { toast(res && res.error || '삭제 실패', 'bad'); return; }
  toast(`${m} 근무표 삭제됨 (${res.removed}건)`, 'good');
  await loadScheduleStatus();
  await viewSchedule();
  loadPayroll();
}
async function loadPayroll() {
  const res = await api.computePayroll($('payMonth').value);
  if (!res.ok) { toast(res.error || '계산 실패', 'bad'); return; }
  const closed = !!res.closed;
  $('btnClosePay').classList.toggle('hidden', closed);
  $('btnReopenPay').classList.toggle('hidden', !closed);
  $('payClosed').classList.toggle('hidden', !closed);
  const H = (m) => (Math.round(m / 60 * 10) / 10) + 'h';
  const won = (n) => (n || 0).toLocaleString();
  const tb = $('payTbody');
  if (!res.rows.length) { tb.innerHTML = '<tr><td colspan="12" style="text-align:center;color:#94a3b8;padding:24px">직원이 없습니다.</td></tr>'; return; }
  const rowHtml = (r) => `<tr>
    <td><b>${escapeHtml(r.name)}</b></td>
    <td>${r.payType === 'monthly' ? '월급' : '시급'}</td>
    <td>${H(r.regularMin)}</td>
    <td>${r.overtimeMin ? H(r.overtimeMin) : '-'}</td>
    <td>${r.nightMin ? H(r.nightMin) : '-'}</td>
    <td>${r.holidayMin ? H(r.holidayMin) : '-'}</td>
    <td>${r.lateDays ? r.lateDays + '일' : '-'}</td>
    <td>${r.earlyDays ? r.earlyDays + '일' : '-'}</td>
    <td>${r.absentDays ? `<span class="tag off">${r.absentDays}일</span>` : '-'}</td>
    <td>${r.weeklyHolidayMin ? H(r.weeklyHolidayMin) : '-'}</td>
    <td>${won(r.addTotal + r.weeklyHolidayPay)}원</td>
    <td>${r.unclosedDays ? `<span class="tag warn">미퇴근 ${r.unclosedDays}</span>` : ''}</td>
  </tr>`;
  const grp = {}; res.rows.forEach((r) => { const rg = r.region || '미지정'; (grp[rg] = grp[rg] || []).push(r); });
  tb.innerHTML = Object.keys(grp).sort((a, b) => a.localeCompare(b, 'ko')).map((rg) =>
    `<tr class="region-row"><td colspan="12">📍 ${escapeHtml(rg)} · ${grp[rg].length}명</td></tr>` + grp[rg].map(rowHtml).join('')
  ).join('');
}
async function exportPay() {
  const res = await api.exportPayroll($('payMonth').value);
  if (res.ok) toast(`근태 엑셀 저장됨 (${res.count}명)`, 'good');
  else if (res.error && res.error !== '취소되었습니다.') toast(res.error, 'bad');
}

// ---------- 월마감 ----------
async function closePay() {
  if (!window.confirm($('payMonth').value + ' 급여를 마감할까요?\n마감하면 그 월 집계가 동결되고 점각 보정이 잠깁니다(나중에 취소 가능).')) return;
  const res = await api.closePayroll($('payMonth').value);
  if (res.ok) { toast('월마감 완료 — 집계가 동결되었습니다', 'good'); loadPayroll(); } else toast(res.error || '실패', 'bad');
}
async function reopenPay() {
  if (!window.confirm('마감을 취소하면 다시 보정·재계산할 수 있습니다. 진행할까요?')) return;
  const res = await api.reopenPayroll($('payMonth').value);
  if (res.ok) { toast('마감이 취소되었습니다', 'good'); loadPayroll(); } else toast(res.error || '실패', 'bad');
}

// ---------- 점각 보정 ----------
let corrCtx = { empId: null, workDate: null };
function tsToLocalInput(ts) { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
async function openCorrect(empId, name, workDate) {
  corrCtx = { empId, workDate };
  $('corrTitle').textContent = `점각 보정 — ${name} / ${workDate}`;
  $('corrAddTime').value = workDate + 'T09:00';
  $('corrReason').value = '';
  await refreshCorrect();
  show('corrModal');
}
async function refreshCorrect() {
  const res = await api.punchDetail(corrCtx.empId, corrCtx.workDate);
  if (!res || !res.ok) { toast(res && res.error || '조회 실패', 'bad'); return; }
  $('corrClosedNote').classList.toggle('hidden', !res.closed);
  const box = $('corrPunches');
  box.innerHTML = res.punches.length ? res.punches.map((p) => `
    <div class="corr-punch">
      <span class="corr-type ${p.type}">${p.type === 'in' ? '출근' : '퇴근'}</span>
      <input type="datetime-local" value="${tsToLocalInput(p.ts)}" data-pid="${p.id}" />
      <span class="corr-src">${p.source === 'admin' ? '관리자' : '점각'}</span>
      <button class="ghost-btn small" data-edit="${p.id}">시각저장</button>
      <button class="ghost-btn small danger" data-void="${p.id}">무효화</button>
    </div>`).join('') : '<div class="hint" style="margin:0">이 날 점각 기록이 없습니다. 아래에서 추가할 수 있습니다.</div>';
  box.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', () => doEdit(el.dataset.edit)));
  box.querySelectorAll('[data-void]').forEach((el) => el.addEventListener('click', () => doVoid(el.dataset.void)));
}
function corrReason() { const r = $('corrReason').value.trim(); if (!r) { toast('보정 사유를 입력하세요', 'bad'); return null; } return r; }
async function doEdit(pid) {
  const r = corrReason(); if (!r) return;
  const input = $('corrPunches').querySelector(`input[data-pid="${pid}"]`);
  const ts = new Date(input.value).getTime();
  if (!ts) { toast('시각이 올바르지 않습니다', 'bad'); return; }
  afterCorrect(await api.correctPunch({ action: 'edit_time', empId: corrCtx.empId, workDate: corrCtx.workDate, targetPunchId: pid, newTs: ts, reason: r }));
}
async function doVoid(pid) {
  const r = corrReason(); if (!r) return;
  if (!window.confirm('이 점각을 무효화할까요? (기록은 남고 계산에서 제외됩니다)')) return;
  afterCorrect(await api.correctPunch({ action: 'void', empId: corrCtx.empId, workDate: corrCtx.workDate, targetPunchId: pid, reason: r }));
}
async function doAddMissing() {
  const r = corrReason(); if (!r) return;
  const ts = new Date($('corrAddTime').value).getTime();
  if (!ts) { toast('시각을 선택하세요', 'bad'); return; }
  afterCorrect(await api.correctPunch({ action: 'add_missing', empId: corrCtx.empId, workDate: corrCtx.workDate, newType: $('corrAddType').value, newTs: ts, reason: r }));
}
async function afterCorrect(res) {
  if (!res || !res.ok) { toast(res && res.error || '보정 실패', 'bad'); return; }
  toast('보정되었습니다', 'good');
  $('corrReason').value = '';
  await refreshCorrect();
  await loadPunches();
}

// ---------- 공휴일 ----------
let HOL = [];
async function loadHolidays() {
  const res = await api.getHolidays();
  if (!res || !res.ok) return;
  HOL = res.holidays || [];
  renderHolidays();
}
function renderHolidays() {
  $('holList').innerHTML = HOL.length
    ? HOL.map((h, i) => `<span class="hol-chip">${h.date} ${escapeHtml(h.name || '')}<button data-holdel="${i}">✕</button></span>`).join('')
    : '<span class="hint" style="margin:0">등록된 공휴일이 없습니다.</span>';
  $('holList').querySelectorAll('[data-holdel]').forEach((el) => el.addEventListener('click', () => { HOL.splice(Number(el.dataset.holdel), 1); renderHolidays(); }));
}
function addHoliday() {
  const date = $('holDate').value, name = $('holName').value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('날짜를 선택하세요', 'bad'); return; }
  if (HOL.some((h) => h.date === date)) { toast('이미 등록된 날짜입니다', 'bad'); return; }
  HOL.push({ date, name: name || '공휴일', type: 'public' });
  HOL.sort((a, b) => a.date.localeCompare(b.date));
  $('holName').value = '';
  renderHolidays();
}
async function saveHolidays() {
  const res = await api.saveHolidays(HOL);
  toast(res && res.ok ? '공휴일이 저장되었습니다.' : (res && res.error || '실패'), res && res.ok ? 'good' : 'bad');
}

// ===========================================================================
//  이벤트 바인딩
// ===========================================================================
function bind() {
  // 키오스크
  $('btnAdmin').addEventListener('click', openAdmin);
  document.querySelectorAll('[data-close="pin"]').forEach((b) => b.addEventListener('click', () => { hide('pinOverlay'); resetCur(); }));
  document.querySelectorAll('[data-close="action"]').forEach((b) => b.addEventListener('click', () => { hide('actionOverlay'); resetCur(); }));
  $('btnIn').addEventListener('click', () => doPunch('in'));
  $('btnOut').addEventListener('click', () => doPunch('out'));
  $('btnCancelPunch').addEventListener('click', cancelLastPunch);
  $('btnDoneClose').addEventListener('click', closeDone);

  // 관리자
  $('btnExitAdmin').addEventListener('click', backToKiosk);
  $('gateBtn').addEventListener('click', submitGate);
  $('gateCancel').addEventListener('click', gateCancel);
  $('gatePw').addEventListener('keydown', (e) => { if (e.key === 'Enter') { if ($('gatePw2').classList.contains('hidden')) submitGate(); else $('gatePw2').focus(); } });
  $('gatePw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 직원관리
  $('btnAddEmp').addEventListener('click', () => openEmpModal(null));
  $('btnImportOps').addEventListener('click', importRoster);
  $('em_payType').addEventListener('change', togglePayType);
  $('em_schedType').addEventListener('change', toggleSchedType);
  $('btnSaveEmp').addEventListener('click', saveEmp);
  $('btnDeactivate').addEventListener('click', deactivateEmp);
  document.querySelectorAll('[data-close="emp"]').forEach((b) => b.addEventListener('click', () => hide('empModal')));

  // 점각기록
  $('btnReloadPunch').addEventListener('click', loadPunches);
  $('filterMonth').addEventListener('change', loadPunches);
  $('filterEmp').addEventListener('change', loadPunches);
  document.querySelectorAll('[data-close="corr"]').forEach((b) => b.addEventListener('click', () => hide('corrModal')));
  $('corrAddBtn').addEventListener('click', doAddMissing);
  $('btnBulkTemplate').addEventListener('click', bulkTemplate);
  $('btnBulkImport').addEventListener('click', bulkImport);

  // 급여
  $('btnImportSchedule').addEventListener('click', importSchedule);
  $('btnViewSchedule').addEventListener('click', viewSchedule);
  $('btnClearSchedule').addEventListener('click', clearSchedule);
  $('btnComputePay').addEventListener('click', () => { loadPayroll(); viewSchedule(); });
  $('payMonth').addEventListener('change', () => { loadPayroll(); viewSchedule(); }); // 월 바꾸면 그 달 근무표로 갱신
  $('btnExportPay').addEventListener('click', exportPay);
  $('btnClosePay').addEventListener('click', closePay);
  $('btnReopenPay').addEventListener('click', reopenPay);

  // 공휴일
  $('btnAddHol').addEventListener('click', addHoliday);
  $('btnSaveHol').addEventListener('click', saveHolidays);

  // 설정
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnChangePw').addEventListener('click', () => { gateMode = 'change'; showGate(); });
  $('btnBackup').addEventListener('click', async () => { const r = await api.runBackup(); toast(r.ok ? '백업 완료' : (r.error || '실패'), r.ok ? 'good' : 'bad'); });
  $('btnOpenData').addEventListener('click', () => api.openDataFolder());
  $('btnOpenBackup').addEventListener('click', () => api.openBackupFolder());
  $('btnIntegrity').addEventListener('click', runIntegrity);

  // 키오스크 잠금 중 종료 차단 알림
  api.onBlockedClose(() => toast('키오스크 잠금 상태입니다. 관리자 설정에서 잠금을 해제한 뒤 종료하세요.', 'bad'));
}

// ---------- 시작 ----------
if (!window.api) showFatal('preload api를 찾지 못했습니다 (preload.js 로드 실패).');
try {
  tickClock();
  setInterval(tickClock, 1000);
  bind();
  loadKiosk();
} catch (e) {
  showFatal((e && e.stack) || String(e));
}
})();
