'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 공통
  getSettings: () => ipcRenderer.invoke('settings:get'),
  dataDir: () => ipcRenderer.invoke('app:dataDir'),

  // 키오스크
  listEmployeesPublic: () => ipcRenderer.invoke('emp:listPublic'),
  empStatus: (empId) => ipcRenderer.invoke('emp:status', empId),
  verifyPin: (empId, pin) => ipcRenderer.invoke('emp:verifyPin', empId, pin),
  punch: (empId, pin, type) => ipcRenderer.invoke('punch:do', empId, pin, type),
  cancelPunch: (punchId, empId, pin) => ipcRenderer.invoke('punch:cancel', punchId, empId, pin),

  // 관리자
  adminStatus: () => ipcRenderer.invoke('admin:status'),
  adminSetPassword: (pw) => ipcRenderer.invoke('admin:setPassword', pw),
  adminVerify: (pw) => ipcRenderer.invoke('admin:verify', pw),
  adminLock: () => ipcRenderer.invoke('admin:lock'),
  listEmployeesFull: () => ipcRenderer.invoke('emp:listFull'),
  saveEmployee: (emp) => ipcRenderer.invoke('emp:save', emp),
  setEmployeePin: (id, pin) => ipcRenderer.invoke('emp:setPin', id, pin),
  deactivateEmployee: (id) => ipcRenderer.invoke('emp:deactivate', id),
  deleteEmployee: (id) => ipcRenderer.invoke('emp:delete', id),
  importRoster: () => ipcRenderer.invoke('emp:importRoster'),
  importSchedule: () => ipcRenderer.invoke('schedule:importPlan'),
  scheduleStatus: () => ipcRenderer.invoke('schedule:status'),
  scheduleList: (month) => ipcRenderer.invoke('schedule:list', month),
  clearSchedule: (month) => ipcRenderer.invoke('schedule:clear', month),
  listPunches: (filter) => ipcRenderer.invoke('punch:list', filter),
  computePayroll: (month) => ipcRenderer.invoke('payroll:compute', month),
  exportPayroll: (month) => ipcRenderer.invoke('payroll:export', month),
  closePayroll: (month) => ipcRenderer.invoke('payroll:close', month),
  reopenPayroll: (month) => ipcRenderer.invoke('payroll:reopen', month),
  punchDetail: (empId, workDate) => ipcRenderer.invoke('punch:detail', empId, workDate),
  correctPunch: (payload) => ipcRenderer.invoke('punch:correct', payload),
  bulkTemplate: (start, end) => ipcRenderer.invoke('punch:bulkTemplate', start, end),
  bulkImport: () => ipcRenderer.invoke('punch:bulkImport'),
  getHolidays: () => ipcRenderer.invoke('holidays:get'),
  saveHolidays: (list) => ipcRenderer.invoke('holidays:save', list),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  runBackup: () => ipcRenderer.invoke('backup:run'),
  integrityCheck: () => ipcRenderer.invoke('integrity:check'),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  openBackupFolder: () => ipcRenderer.invoke('backup:openFolder'),

  // 이벤트
  onBlockedClose: (cb) => ipcRenderer.on('kiosk:blockedClose', cb)
});
