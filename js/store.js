'use strict';
/* ===== Dữ liệu, lưu trữ (IndexedDB), tiện ích, CSV, PIN ===== */

const DB_NAME = 'sothuchi';
const DB_STORE = 'kv';
const DB_KEY = 'state';
const CURRENCIES = ['VND', 'USD', 'EUR', 'JPY', 'CNY', 'KRW', 'SGD', 'THB', 'GBP', 'AUD'];
const ZERO_DEC = ['VND', 'JPY', 'KRW'];
const COLORS = ['#E53935', '#D81B60', '#8E24AA', '#5E35B1', '#3949AB', '#1E88E5', '#039BE5', '#00ACC1',
  '#00897B', '#43A047', '#7CB342', '#FDD835', '#FB8C00', '#F4511E', '#6D4C41', '#607D8B'];
const EMOJIS = ['💵', '💳', '🏦', '👛', '💰', '🪙', '🏧', '📱', '🛒', '🍜', '☕', '🚗', '🚌', '⛽', '✈️', '🏠',
  '💡', '💧', '📶', '🎓', '📚', '💊', '🏥', '🎮', '🎬', '🎵', '🎁', '❤️', '🐶', '🌿', '📷', '✂️',
  '🔧', '🏋️', '👕', '💼', '📈', '⭐', '➕', '📦', '🧾', '🎯', '🏖️', '🚲'];

const DEFAULT_EXPENSE = [
  ['Ăn uống', '🍜', '#FB8C00'], ['Di chuyển', '🚗', '#1E88E5'], ['Mua sắm', '🛒', '#D81B60'],
  ['Hóa đơn', '🧾', '#5E35B1'], ['Nhà cửa', '🏠', '#6D4C41'], ['Sức khỏe', '💊', '#E53935'],
  ['Giải trí', '🎮', '#8E24AA'], ['Giáo dục', '📚', '#3949AB'], ['Gia đình', '❤️', '#F4511E'],
  ['Quà tặng', '🎁', '#00ACC1'], ['Du lịch', '✈️', '#039BE5'], ['Khác', '📦', '#607D8B']
];
const DEFAULT_INCOME = [
  ['Lương', '💰', '#43A047'], ['Thưởng', '⭐', '#FDD835'], ['Đầu tư', '📈', '#00897B'], ['Thu nhập khác', '➕', '#7CB342']
];

let S = null; // toàn bộ dữ liệu

const pad = n => String(n).padStart(2, '0');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- IndexedDB ---------- */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Trạng thái ---------- */
function emptyState() {
  return {
    v: 1, wallets: [], categories: [], tx: [], budgets: [], recurring: [], debts: [], goals: [],
    settings: { base: 'VND', rates: {}, pinHash: null, pinSalt: null, pinLen: 4, lockAfter: 60, lastBackup: 0 }
  };
}

function seedDefaults(st) {
  let order = 0;
  if (!st.categories.length) {
    for (const [name, icon, color] of DEFAULT_EXPENSE) st.categories.push({ id: uid(), name, icon, color, kind: 'expense', order: order++ });
    for (const [name, icon, color] of DEFAULT_INCOME) st.categories.push({ id: uid(), name, icon, color, kind: 'income', order: order++ });
  }
  if (!st.wallets.length) {
    st.wallets.push({ id: uid(), name: 'Tiền mặt', icon: '💵', color: '#43A047', currency: st.settings.base,
      initial: 0, excludeTotal: false, archived: false, order: 0, created: Date.now() });
  }
}

function normalize(st) {
  const base = emptyState();
  for (const k of Object.keys(base)) if (st[k] === undefined) st[k] = base[k];
  st.settings = Object.assign({}, base.settings, st.settings || {});
  seedDefaults(st);
  return st;
}

async function loadState() {
  let data = null;
  try { data = await idbGet(DB_KEY); } catch (e) { console.warn('IndexedDB lỗi', e); }
  S = normalize(data || emptyState());
  if (!data) await flush();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 30);
}
async function flush() {
  clearTimeout(saveTimer);
  try { await idbSet(DB_KEY, S); } catch (e) { console.error(e); if (window.toast) toast('Không lưu được dữ liệu!'); }
}

/* ---------- Truy vấn ---------- */
const walletById = id => S.wallets.find(w => w.id === id);
const catById = id => S.categories.find(c => c.id === id);
const rate = code => (code === S.settings.base ? 1 : (S.settings.rates[code] || 1));
const toBase = (amount, code) => amount * rate(code);
const txCurrency = t => (walletById(t.walletId) || {}).currency || S.settings.base;
const signed = t => (t.kind === 'income' ? t.amount : -t.amount);
const walletBalance = w => w.initial + S.tx.reduce((s, t) => (t.walletId === w.id ? s + signed(t) : s), 0);

function totals(list) {
  let inc = 0, exp = 0;
  for (const t of list) {
    if (t.transfer) continue;
    const v = toBase(t.amount, txCurrency(t));
    if (t.kind === 'income') inc += v; else exp += v;
  }
  return { inc, exp };
}

/* ---------- Định dạng ---------- */
const fmtCache = {};
function money(v, cur) {
  cur = cur || S.settings.base;
  let f = fmtCache[cur];
  if (!f) {
    f = fmtCache[cur] = new Intl.NumberFormat('vi-VN', {
      style: 'currency', currency: cur, maximumFractionDigits: ZERO_DEC.includes(cur) ? 0 : 2
    });
  }
  return f.format(v);
}
function compact(v) {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  const t = x => String(+x.toFixed(1)).replace('.', ',');
  if (a >= 1e9) return s + t(a / 1e9) + ' tỷ';
  if (a >= 1e6) return s + t(a / 1e6) + ' tr';
  if (a >= 1e3) return s + t(a / 1e3) + 'k';
  return s + t(a);
}
const plain = v => (Number.isInteger(v) ? String(v) : String(+v.toFixed(4)));
function parseNum(s) {
  s = String(s == null ? '' : s).trim().replace(/,/g, '.');
  if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}
const pct = v => Math.round(v * 100) + '%';

/* ---------- Ngày ---------- */
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const monthStart = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const monthEnd = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1; };
const addMonths = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };
const monthTitle = ts => { const d = new Date(ts); return `Tháng ${d.getMonth() + 1}, ${d.getFullYear()}`; };
const shortMonth = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`; };
const DAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const dayTitle = ts => { const d = new Date(ts); return `${DAYS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const shortDate = ts => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const toInputDT = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInputDT = s => { const t = new Date(s).getTime(); return Number.isNaN(t) ? Date.now() : t; };
const toInputD = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fromInputD = s => (s ? new Date(s + 'T00:00').getTime() : null);
const daysLeftInMonth = ts => {
  const now = new Date();
  const d = new Date(ts);
  if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) return 0;
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - now.getDate() + 1;
};

/* ---------- Giao dịch định kỳ ---------- */
const FREQS = [['daily', 'Hàng ngày'], ['weekly', 'Hàng tuần'], ['monthly', 'Hàng tháng'], ['yearly', 'Hàng năm']];
function recurDate(r, n) {
  const s = new Date(r.start);
  if (r.freq === 'daily') return new Date(s.getFullYear(), s.getMonth(), s.getDate() + n, s.getHours(), s.getMinutes()).getTime();
  if (r.freq === 'weekly') return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * n, s.getHours(), s.getMinutes()).getTime();
  const months = r.freq === 'monthly' ? n : 12 * n;
  const y = s.getFullYear(), m = s.getMonth() + months;
  const dim = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(s.getDate(), dim), s.getHours(), s.getMinutes()).getTime();
}
function fastForward(r) {
  let n = 0;
  const now = Date.now();
  while (recurDate(r, n) <= now && n < 5000) n++;
  r.occ = n;
}
function processRecurring() {
  const now = Date.now();
  let created = 0;
  for (const r of S.recurring) {
    if (!r.active || !walletById(r.walletId)) continue;
    let guard = 0;
    while (recurDate(r, r.occ) <= now && guard < 400) {
      S.tx.push({ id: uid(), amount: r.amount, kind: r.kind, date: recurDate(r, r.occ),
        note: r.note || r.name, walletId: r.walletId, catId: r.catId, transfer: false, pair: null });
      r.occ++; guard++; created++;
    }
  }
  if (created) save();
  return created;
}

/* ---------- CSV (cùng định dạng với bản iOS) ---------- */
const CSV_HEADER = ['date', 'type', 'amount', 'currency', 'wallet', 'category', 'note', 'transfer'];
const csvEscape = s => { s = String(s == null ? '' : s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvStamp = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

function csvParseDate(s) {
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime();
  return null;
}

function csvParse(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function exportCSV() {
  const lines = [CSV_HEADER.join(',')];
  const row = a => a.map(csvEscape).join(',');
  for (const w of S.wallets) lines.push(row([csvStamp(w.created || Date.now()), 'opening', plain(w.initial), w.currency, w.name, '', '', '0']));
  const list = S.tx.slice().sort((a, b) => a.date - b.date);
  for (const t of list) {
    const w = walletById(t.walletId), c = catById(t.catId);
    lines.push(row([csvStamp(t.date), t.kind, plain(t.amount), txCurrency(t), w ? w.name : '', c ? c.name : '', t.note || '', t.transfer ? '1' : '0']));
  }
  return '﻿' + lines.join('\n') + '\n';
}

function importCSV(raw) {
  let text = raw;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = csvParse(text);
  if (!rows.length) throw new Error('File trống.');
  const names = rows[0].map(s => s.trim().toLowerCase());
  const ix = n => names.indexOf(n);
  const iDate = ix('date'), iType = ix('type'), iAmount = ix('amount');
  if (iDate < 0 || iType < 0 || iAmount < 0) throw new Error('File thiếu cột bắt buộc (date, type, amount).');
  const iCur = ix('currency'), iWal = ix('wallet'), iCat = ix('category'), iNote = ix('note'), iTr = ix('transfer');

  const wallets = {}, cats = {}, created = new Set();
  S.wallets.forEach(w => { wallets[w.name.toLowerCase()] = w; });
  S.categories.forEach(c => { cats[c.kind + '|' + c.name.toLowerCase()] = c; });
  const key = (d, a, k, w, n) => `${Math.floor(d / 1000)}|${plain(a)}|${k}|${String(w).toLowerCase()}|${n}`;
  const seen = new Set(S.tx.map(t => key(t.date, t.amount, t.kind, (walletById(t.walletId) || {}).name || '', t.note || '')));

  const getWallet = (name, cur) => {
    const k = name.toLowerCase();
    if (wallets[k]) return wallets[k];
    const w = { id: uid(), name, icon: '💵', color: '#43A047', currency: cur || S.settings.base, initial: 0,
      excludeTotal: false, archived: false, order: S.wallets.length, created: Date.now() };
    S.wallets.push(w); wallets[k] = w; created.add(k);
    return w;
  };
  const getCat = (name, kind) => {
    const k = kind + '|' + name.toLowerCase();
    if (cats[k]) return cats[k];
    const c = { id: uid(), name, icon: '📦', color: '#607D8B', kind, order: S.categories.length };
    S.categories.push(c); cats[k] = c;
    return c;
  };
  const cell = (r, i) => (i >= 0 && i < r.length ? r[i].trim() : '');

  let imported = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const type = cell(r, iType).toLowerCase();
    const date = csvParseDate(cell(r, iDate));
    const amount = parseNum(cell(r, iAmount));
    if (date == null || amount == null) { skipped++; continue; }
    const wName = cell(r, iWal) || 'Tiền mặt';
    const cur = cell(r, iCur);
    if (type === 'opening') {
      const w = getWallet(wName, cur);
      if (created.has(w.name.toLowerCase())) { w.initial = amount; w.created = date; }
      continue;
    }
    if (type !== 'expense' && type !== 'income') { skipped++; continue; }
    if (!(amount > 0)) { skipped++; continue; }
    const note = cell(r, iNote);
    const k = key(date, amount, type, wName, note);
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    const transfer = cell(r, iTr) === '1';
    const w = getWallet(wName, cur);
    const cName = cell(r, iCat);
    S.tx.push({ id: uid(), amount, kind: type, date, note, walletId: w.id,
      catId: !transfer && cName ? getCat(cName, type).id : null, transfer, pair: null });
    imported++;
  }
  save();
  return { imported, skipped };
}

/* ---------- Sao lưu JSON ---------- */
function exportJSON() { return JSON.stringify(S); }
function importJSON(text) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.wallets) || !Array.isArray(o.tx) || !Array.isArray(o.categories)) {
    throw new Error('File sao lưu không hợp lệ.');
  }
  S = normalize(o);
  return flush();
}

/* ---------- PIN ---------- */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function setPin(pin) {
  S.settings.pinSalt = uid();
  S.settings.pinLen = pin.length;
  S.settings.pinHash = await sha256(S.settings.pinSalt + pin);
  save();
}
async function checkPin(pin) {
  return (await sha256(S.settings.pinSalt + pin)) === S.settings.pinHash;
}
function clearPin() {
  S.settings.pinHash = null; S.settings.pinSalt = null;
  save();
}

/* ---------- Xóa dữ liệu ---------- */
async function wipeAll() {
  const lastBackup = S.settings.lastBackup;
  S = normalize(emptyState());
  S.settings.lastBackup = lastBackup;
  await flush();
}
