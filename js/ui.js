'use strict';
/* ===== Giao diện ===== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

const UI = {
  tab: 'tx', sub: null,
  monthTx: monthStart(Date.now()), monthBud: monthStart(Date.now()), monthRep: monthStart(Date.now()),
  search: '', wfilter: '', repKind: 'expense', catKind: 'expense', lastWallet: null, importKind: 'csv'
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
window.toast = toast;

/* ---------- Thành phần HTML nhỏ ---------- */
const field = (label, inner) => `<label class="field"><span>${label}</span>${inner}</label>`;
const seg = (group, items, sel) => `<div class="seg">${items.map(([v, t]) =>
  `<button type="button" class="${v === sel ? 'sel' : ''}" data-pick="${group}" data-val="${esc(v)}">${esc(t)}</button>`).join('')}</div>`;
const optionsHtml = (items, sel) => items.map(([v, t]) =>
  `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(t)}</option>`).join('');
const ico = (icon, color, size) => `<span class="ico" style="background:${color}${size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px` : ''}">${icon}</span>`;
const emojiPicker = sel => `<div class="picker">${EMOJIS.map(e =>
  `<button type="button" class="${e === sel ? 'sel' : ''}" data-pick="icon" data-val="${e}">${e}</button>`).join('')}</div>`;
const colorPicker = sel => `<div class="picker colors">${COLORS.map(c =>
  `<button type="button" class="${c === sel ? 'sel' : ''}" data-pick="color" data-val="${c}" style="background:${c}"></button>`).join('')}</div>`;
const catGrid = (kind, sel) => `<div class="catgrid">${S.categories.filter(c => c.kind === kind).sort(byOrder).map(c =>
  `<button type="button" class="cat${c.id === sel ? ' sel' : ''}" data-pick="cat" data-val="${c.id}">${ico(c.icon, c.color, 44)}<small>${esc(c.name)}</small></button>`).join('')}</div>`;
const bar = (ratio, color) => `<div class="bar"><i style="width:${Math.min(Math.max(ratio, 0), 1) * 100}%;background:${color}"></i></div>`;
const monthSwitch = key => `<div class="mswitch"><button data-act="mprev" data-k="${key}">‹</button><b>${monthTitle(UI[key])}</b><button data-act="mnext" data-k="${key}">›</button></div>`;
const strip = t => {
  const net = t.inc - t.exp;
  return `<div class="strip"><div><small>Thu nhập</small><b class="pos">${compact(t.inc)}</b></div>
    <div><small>Chi tiêu</small><b class="neg">${compact(t.exp)}</b></div>
    <div><small>Chênh lệch</small><b class="${net >= 0 ? 'pos' : 'neg'}">${compact(net)}</b></div></div>`;
};
const empty = (title, hint) => `<div class="empty"><b>${title}</b><br>${hint || ''}</div>`;

/* ---------- Sheet (hộp thoại thêm/sửa) ---------- */
let sheetState = null;
function openSheet(title, bodyHtml, opts = {}) {
  sheetState = opts;
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = bodyHtml + (opts.onDelete ? `<button type="button" class="btn danger" id="sheet-delete">${opts.deleteLabel || 'Xóa'}</button>` : '');
  $('#sheet-save').style.visibility = opts.onSave ? 'visible' : 'hidden';
  $('#sheet-backdrop').hidden = false;
  $('#sheet-body').scrollTop = 0;
  document.body.classList.add('noscroll');
}
function closeSheet() {
  $('#sheet-backdrop').hidden = true;
  document.body.classList.remove('noscroll');
  sheetState = null;
}
function initSheet() {
  $('#sheet-cancel').onclick = closeSheet;
  $('#sheet-backdrop').addEventListener('click', e => { if (e.target.id === 'sheet-backdrop') closeSheet(); });
  $('#sheet-save').onclick = () => {
    if (!sheetState || !sheetState.onSave) return;
    if (sheetState.onSave() === false) return;
    closeSheet(); render();
  };
  $('#sheet').addEventListener('click', e => {
    const p = e.target.closest('[data-pick]');
    if (p) {
      const g = p.dataset.pick;
      $$(`[data-pick="${g}"]`, $('#sheet')).forEach(x => x.classList.toggle('sel', x === p));
      if (sheetState && sheetState.onPick) sheetState.onPick(g, p.dataset.val);
      return;
    }
    if (e.target.id === 'sheet-delete' && sheetState && sheetState.onDelete) {
      if (sheetState.onDelete() === false) return;
      closeSheet(); render();
    }
  });
  $('#sheet').addEventListener('change', e => { if (sheetState && sheetState.onChange) sheetState.onChange(e); });
}

/* ---------- Giao dịch ---------- */
function monthWalletTx() {
  const a = monthStart(UI.monthTx), z = monthEnd(UI.monthTx);
  return S.tx.filter(t => t.date >= a && t.date <= z && (!UI.wfilter || t.walletId === UI.wfilter));
}
function visibleTx() {
  const q = UI.search.trim().toLowerCase();
  let l = monthWalletTx();
  if (q) l = l.filter(t => (t.note || '').toLowerCase().includes(q) || ((catById(t.catId) || {}).name || '').toLowerCase().includes(q));
  return l.sort((a, b) => b.date - a.date);
}
function txRow(t) {
  const c = catById(t.catId), w = walletById(t.walletId);
  const title = t.transfer ? 'Chuyển khoản' : (c ? c.name : 'Chưa phân loại');
  const sub = [t.note, w ? w.name : ''].filter(Boolean).join(' • ');
  const icon = t.transfer ? ico('⇄', '#607D8B') : ico(c ? c.icon : '❔', c ? c.color : '#9E9E9E');
  const cls = t.transfer ? 'muted' : (t.kind === 'income' ? 'pos' : 'neg');
  return `<div class="row" data-act="editTx" data-id="${t.id}">${icon}<div class="grow"><div>${esc(title)}</div><small>${esc(sub)}</small></div>
    <b class="${cls}">${t.kind === 'income' ? '+' : '-'}${money(t.amount, txCurrency(t))}</b></div>`;
}
function txListHtml() {
  const list = visibleTx();
  if (!list.length) return empty('Chưa có giao dịch', 'Nhấn ＋ để thêm giao dịch.');
  const groups = new Map();
  for (const t of list) {
    const d = startOfDay(t.date);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(t);
  }
  let h = '';
  for (const [d, items] of groups) {
    const net = items.filter(t => !t.transfer).reduce((s, t) => s + toBase(signed(t), txCurrency(t)), 0);
    h += `<div class="dayhead"><span>${dayTitle(d)}</span><span>${compact(net)}</span></div><div class="card list">${items.map(txRow).join('')}</div>`;
  }
  return h;
}
function backupBanner() {
  if (S.tx.length < 5) return '';
  const b = S.settings.lastBackup;
  const days = b ? Math.floor((Date.now() - b) / 864e5) : null;
  if (days !== null && days < 14) return '';
  return `<div class="banner" data-act="goData">💾 ${days === null ? 'Bạn chưa sao lưu dữ liệu lần nào.' : `Đã ${days} ngày chưa sao lưu.`} Chạm để sao lưu.</div>`;
}
function txView() {
  const wf = [['', 'Tất cả ví']].concat(S.wallets.slice().sort(byOrder).map(w => [w.id, w.name]));
  return `${backupBanner()}<div class="card pad">${monthSwitch('monthTx')}${strip(totals(monthWalletTx()))}</div>
    <div class="filters"><input id="search" type="search" placeholder="Tìm ghi chú, danh mục" value="${esc(UI.search)}">
    <select id="wfilter">${optionsHtml(wf, UI.wfilter)}</select></div>
    <div id="txlist">${txListHtml()}</div><button class="fab" data-act="addTx" aria-label="Thêm giao dịch">＋</button>`;
}

function txSheet(id) {
  const t = id ? S.tx.find(x => x.id === id) : null;
  const isTransfer = !!(t && t.transfer);
  const wallets = S.wallets.filter(w => !w.archived || (t && w.id === t.walletId)).sort(byOrder);
  if (!wallets.length) return toast('Hãy tạo ví trước');
  let kind = t ? t.kind : 'expense';
  let catId = t ? t.catId : null;
  const wid = t ? t.walletId : (wallets.some(w => w.id === UI.lastWallet) ? UI.lastWallet : wallets[0].id);
  const body = (isTransfer ? '' : seg('kind', [['expense', 'Chi tiêu'], ['income', 'Thu nhập']], kind))
    + field('Số tiền', `<input id="f-amount" class="big" inputmode="decimal" placeholder="0" value="${t ? plain(t.amount) : ''}">`)
    + (isTransfer ? '' : `<div class="lbl">Danh mục</div><div id="catwrap">${catGrid(kind, catId)}</div>`)
    + field('Ví', `<select id="f-wallet">${optionsHtml(wallets.map(w => [w.id, `${w.name} (${w.currency})`]), wid)}</select>`)
    + field('Thời gian', `<input id="f-date" type="datetime-local" value="${toInputDT(t ? t.date : Date.now())}">`)
    + field('Ghi chú', `<input id="f-note" value="${esc(t ? t.note : '')}" placeholder="Ghi chú">`);
  openSheet(t ? 'Sửa giao dịch' : 'Thêm giao dịch', body, {
    onPick(g, v) {
      if (g === 'kind') {
        kind = v;
        const c = catById(catId);
        if (c && c.kind !== kind) catId = null;
        $('#catwrap').innerHTML = catGrid(kind, catId);
      } else if (g === 'cat') catId = v;
    },
    onSave() {
      const amount = parseNum($('#f-amount').value);
      if (!(amount > 0)) { toast('Nhập số tiền hợp lệ'); return false; }
      if (!isTransfer && !catId) { toast('Hãy chọn danh mục'); return false; }
      const walletId = $('#f-wallet').value;
      const date = fromInputDT($('#f-date').value);
      const note = $('#f-note').value.trim();
      UI.lastWallet = walletId;
      if (t) {
        Object.assign(t, { amount, date, note, walletId });
        if (!isTransfer) { t.kind = kind; t.catId = catId; }
      } else {
        S.tx.push({ id: uid(), amount, kind, date, note, walletId, catId, transfer: false, pair: null });
      }
      save();
    },
    onDelete: t ? () => {
      const hasPair = t.pair && S.tx.some(x => x.id === t.pair);
      if (!confirm(hasPair ? 'Xóa giao dịch chuyển khoản này và giao dịch đối ứng?' : 'Xóa giao dịch này?')) return false;
      S.tx = S.tx.filter(x => x.id !== t.id && x.id !== t.pair);
      save();
    } : null
  });
}

/* ---------- Ví ---------- */
function walletsView() {
  const active = S.wallets.filter(w => !w.archived).sort(byOrder);
  const arch = S.wallets.filter(w => w.archived).sort(byOrder);
  const total = active.filter(w => !w.excludeTotal).reduce((s, w) => s + toBase(walletBalance(w), w.currency), 0);
  const row = w => {
    const b = walletBalance(w);
    return `<div class="row" data-act="editWallet" data-id="${w.id}">${ico(w.icon, w.color)}
      <div class="grow"><div>${esc(w.name)}</div><small>${w.currency}${w.excludeTotal ? ' • Không tính vào tổng' : ''}</small></div>
      <b class="${b < 0 ? 'neg' : ''}">${money(b, w.currency)}</b></div>`;
  };
  return `<div class="card total"><small>Tổng số dư</small><h2 class="${total < 0 ? 'neg' : ''}">${money(total)}</h2></div>
    <div class="sect">Ví của tôi</div><div class="card list">${active.map(row).join('')}</div>
    ${arch.length ? `<div class="sect">Đã lưu trữ</div><div class="card list">${arch.map(row).join('')}</div>` : ''}`;
}

function walletSheet(id) {
  const w = id ? walletById(id) : null;
  let icon = w ? w.icon : '💵', color = w ? w.color : '#43A047';
  const body = field('Tên ví', `<input id="f-name" value="${esc(w ? w.name : '')}" placeholder="VD: Techcombank">`)
    + field('Tiền tệ', `<select id="f-cur">${optionsHtml(CURRENCIES.map(c => [c, c]), w ? w.currency : S.settings.base)}</select>`)
    + field('Số dư ban đầu', `<input id="f-init" inputmode="decimal" placeholder="0" value="${w ? plain(w.initial) : ''}">`)
    + `<div class="lbl">Biểu tượng</div>${emojiPicker(icon)}<div class="lbl">Màu sắc</div>${colorPicker(color)}`
    + `<label class="check"><input type="checkbox" id="f-excl" ${w && w.excludeTotal ? 'checked' : ''}> Không tính vào tổng số dư</label>`
    + (w ? `<label class="check"><input type="checkbox" id="f-arch" ${w.archived ? 'checked' : ''}> Lưu trữ ví (ẩn khỏi danh sách chọn)</label>` : '');
  openSheet(w ? 'Sửa ví' : 'Thêm ví', body, {
    onPick(g, v) { if (g === 'icon') icon = v; if (g === 'color') color = v; },
    onSave() {
      const name = $('#f-name').value.trim();
      if (!name) { toast('Nhập tên ví'); return false; }
      const data = { name, icon, color, currency: $('#f-cur').value, initial: parseNum($('#f-init').value) || 0, excludeTotal: $('#f-excl').checked };
      if (w) { Object.assign(w, data); w.archived = $('#f-arch').checked; }
      else S.wallets.push(Object.assign({ id: uid(), archived: false, order: S.wallets.length, created: Date.now() }, data));
      save();
    },
    onDelete: w ? () => {
      if (S.wallets.length <= 1) { toast('Cần giữ lại ít nhất một ví'); return false; }
      const n = S.tx.filter(t => t.walletId === w.id).length;
      if (!confirm(`Xóa ví "${w.name}" và ${n} giao dịch trong ví? Không thể hoàn tác.`)) return false;
      S.tx = S.tx.filter(t => t.walletId !== w.id);
      S.recurring = S.recurring.filter(r => r.walletId !== w.id);
      S.wallets = S.wallets.filter(x => x.id !== w.id);
      save();
    } : null
  });
}

function transferSheet() {
  const ws = S.wallets.filter(w => !w.archived).sort(byOrder);
  if (ws.length < 2) return toast('Cần ít nhất 2 ví để chuyển tiền');
  const wopts = ws.map(w => [w.id, `${w.name} (${w.currency})`]);
  const body = field('Từ ví', `<select id="f-from">${optionsHtml(wopts, ws[0].id)}</select>`)
    + field('Đến ví', `<select id="f-to">${optionsHtml(wopts, ws[1].id)}</select>`)
    + field('<span id="l-amt">Số tiền chuyển</span>', `<input id="f-amount" class="big" inputmode="decimal" placeholder="0">`)
    + `<div id="recv-wrap" hidden>${field('<span id="l-recv">Số tiền nhận</span>', `<input id="f-recv" inputmode="decimal" placeholder="0">`)}</div>`
    + field('Thời gian', `<input id="f-date" type="datetime-local" value="${toInputDT(Date.now())}">`)
    + field('Ghi chú', `<input id="f-note" placeholder="Ghi chú">`);
  const sync = () => {
    const a = walletById($('#f-from').value), b = walletById($('#f-to').value);
    $('#recv-wrap').hidden = !(a && b && a.currency !== b.currency);
    $('#l-amt').textContent = `Số tiền chuyển (${a ? a.currency : ''})`;
    $('#l-recv').textContent = `Số tiền nhận (${b ? b.currency : ''})`;
  };
  openSheet('Chuyển tiền giữa các ví', body, {
    onChange: sync,
    onSave() {
      const a = walletById($('#f-from').value), b = walletById($('#f-to').value);
      if (!a || !b || a.id === b.id) { toast('Chọn hai ví khác nhau'); return false; }
      const amount = parseNum($('#f-amount').value);
      const recv = a.currency === b.currency ? amount : parseNum($('#f-recv').value);
      if (!(amount > 0) || !(recv > 0)) { toast('Nhập số tiền hợp lệ'); return false; }
      const date = fromInputDT($('#f-date').value), note = $('#f-note').value.trim();
      const out = { id: uid(), amount, kind: 'expense', date, note: note || `Chuyển đến ${b.name}`, walletId: a.id, catId: null, transfer: true, pair: null };
      const inc = { id: uid(), amount: recv, kind: 'income', date, note: note || `Nhận từ ${a.name}`, walletId: b.id, catId: null, transfer: true, pair: out.id };
      out.pair = inc.id;
      S.tx.push(out, inc);
      save();
    }
  });
  sync();
}

/* ---------- Ngân sách ---------- */
function budgetSpent(b, a, z) {
  let s = 0;
  for (const t of S.tx) {
    if (t.date < a || t.date > z || t.kind !== 'expense' || t.transfer) continue;
    if (b.catId && t.catId !== b.catId) continue;
    s += toBase(t.amount, txCurrency(t));
  }
  return s;
}
function budgetsView() {
  const a = monthStart(UI.monthBud), z = monthEnd(UI.monthBud), left = daysLeftInMonth(UI.monthBud);
  const list = S.budgets.slice().sort((x, y) => (x.catId ? 1 : 0) - (y.catId ? 1 : 0)
    || ((catById(x.catId) || {}).name || '').localeCompare((catById(y.catId) || {}).name || ''));
  const rows = list.map(b => {
    const c = catById(b.catId);
    const spent = budgetSpent(b, a, z), ratio = b.amount > 0 ? spent / b.amount : 0, remain = b.amount - spent;
    const tint = ratio >= 1 ? 'var(--red)' : ratio >= 0.8 ? 'var(--orange)' : 'var(--green)';
    return `<div class="row col" data-act="editBudget" data-id="${b.id}">
      <div class="rowtop">${c ? ico(c.icon, c.color, 32) : ico('🎯', '#607D8B', 32)}<b class="grow">${c ? esc(c.name) : 'Tổng chi tiêu'}</b><b style="color:${tint}">${pct(ratio)}</b></div>
      ${bar(ratio, tint)}
      <div class="rowsub"><span>Đã chi ${compact(spent)} / ${compact(b.amount)}</span>${remain >= 0 ? `<span>Còn ${compact(remain)}</span>` : `<span class="neg">Vượt ${compact(-remain)}</span>`}</div>
      ${left > 0 && remain > 0 ? `<small class="muted">Có thể chi khoảng ${compact(remain / left)}/ngày trong ${left} ngày còn lại</small>` : ''}</div>`;
  }).join('');
  return `<div class="card pad">${monthSwitch('monthBud')}</div>
    ${list.length ? `<div class="card list">${rows}</div><p class="note">Ngân sách áp dụng lặp lại mỗi tháng (đơn vị ${S.settings.base}).</p>` : empty('Chưa có ngân sách', 'Nhấn ＋ để đặt hạn mức chi tiêu hàng tháng.')}`;
}
function budgetSheet(id) {
  const b = id ? S.budgets.find(x => x.id === id) : null;
  const cats = [['', 'Tổng chi tiêu']].concat(S.categories.filter(c => c.kind === 'expense').sort(byOrder).map(c => [c.id, c.name]));
  const body = field('Áp dụng cho', `<select id="f-cat">${optionsHtml(cats, b ? (b.catId || '') : '')}</select>`)
    + field(`Hạn mức mỗi tháng (${S.settings.base})`, `<input id="f-amount" class="big" inputmode="decimal" placeholder="0" value="${b ? plain(b.amount) : ''}">`);
  openSheet(b ? 'Sửa ngân sách' : 'Thêm ngân sách', body, {
    onSave() {
      const amount = parseNum($('#f-amount').value);
      if (!(amount > 0)) { toast('Nhập hạn mức hợp lệ'); return false; }
      const catId = $('#f-cat').value || null;
      if (b) Object.assign(b, { amount, catId }); else S.budgets.push({ id: uid(), amount, catId });
      save();
    },
    onDelete: b ? () => { if (!confirm('Xóa ngân sách này?')) return false; S.budgets = S.budgets.filter(x => x.id !== b.id); save(); } : null
  });
}

/* ---------- Báo cáo ---------- */
function reportSlices(a, z, kind) {
  const m = new Map();
  for (const t of S.tx) {
    if (t.date < a || t.date > z || t.kind !== kind || t.transfer) continue;
    const c = catById(t.catId);
    const name = c ? c.name : 'Chưa phân loại';
    const cur = m.get(name) || { name, color: c ? c.color : '#9E9E9E', icon: c ? c.icon : '❔', value: 0 };
    cur.value += toBase(t.amount, txCurrency(t));
    m.set(name, cur);
  }
  return Array.from(m.values()).sort((x, y) => y.value - x.value);
}
function donutSvg(slices, total, label) {
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = slices.map(s => {
    const len = total > 0 ? s.value / total * C : 0;
    const el = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${s.color}" stroke-width="34" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"/>`;
    off += len;
    return el;
  }).join('');
  return `<svg viewBox="0 0 200 200" class="donut"><circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--line)" stroke-width="34"/>${arcs}
    <text x="100" y="96" text-anchor="middle" class="dl">${label}</text><text x="100" y="118" text-anchor="middle" class="dv">${compact(total)}</text></svg>`;
}
function barsSvg() {
  const data = [];
  for (let i = 5; i >= 0; i--) {
    const m = addMonths(UI.monthRep, -i);
    const t = totals(S.tx.filter(x => x.date >= monthStart(m) && x.date <= monthEnd(m)));
    data.push({ label: shortMonth(m), inc: t.inc, exp: t.exp });
  }
  const max = Math.max(1, ...data.flatMap(d => [d.inc, d.exp]));
  const W = 340, H = 190, top = 16, bottom = 26, ch = H - top - bottom, gw = W / 6, bw = 16;
  let g = '';
  data.forEach((d, i) => {
    const x0 = i * gw + gw / 2, hi = d.inc / max * ch, he = d.exp / max * ch;
    g += `<rect x="${x0 - bw - 1}" y="${top + ch - hi}" width="${bw}" height="${hi}" rx="3" fill="var(--green)"/>
      <rect x="${x0 + 1}" y="${top + ch - he}" width="${bw}" height="${he}" rx="3" fill="var(--red)"/>
      <text x="${x0}" y="${H - 8}" text-anchor="middle" class="axl">${d.label}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="bars"><line x1="0" x2="${W}" y1="${top + ch}" y2="${top + ch}" stroke="var(--line)"/>${g}</svg>
    <div class="legend"><span><i style="background:var(--green)"></i>Thu nhập</span><span><i style="background:var(--red)"></i>Chi tiêu</span></div>`;
}
function reportsView() {
  const a = monthStart(UI.monthRep), z = monthEnd(UI.monthRep);
  const kind = UI.repKind;
  const slices = reportSlices(a, z, kind);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const t = totals(S.tx.filter(x => x.date >= a && x.date <= z));
  return `<div class="card pad">${monthSwitch('monthRep')}${strip(t)}</div>
    <div class="seg wide">${[['expense', 'Chi tiêu'], ['income', 'Thu nhập']].map(([v, n]) =>
      `<button class="${v === kind ? 'sel' : ''}" data-act="repKind" data-v="${v}">${n}</button>`).join('')}</div>
    <div class="card pad">${slices.length ? donutSvg(slices, total, kind === 'expense' ? 'Chi tiêu' : 'Thu nhập') : empty('Không có dữ liệu', 'Chưa có giao dịch trong tháng này.')}</div>
    ${slices.length ? `<div class="card list">${slices.map(s => `<div class="row">${ico(s.icon, s.color, 32)}<div class="grow">${esc(s.name)}</div>
      <div class="right"><b>${money(s.value)}</b><small>${pct(total > 0 ? s.value / total : 0)}</small></div></div>`).join('')}</div>` : ''}
    <div class="sect">6 tháng gần nhất</div><div class="card pad">${barsSvg()}</div>`;
}

/* ---------- Khác ---------- */
function moreView() {
  const link = (sub, icon, label) => `<div class="row link" data-act="open" data-sub="${sub}"><span class="mi">${icon}</span><div class="grow">${label}</div><span class="chev">›</span></div>`;
  return `<div class="sect">Quản lý</div><div class="card list">
    ${link('categories', '🗂️', 'Danh mục')}${link('recurring', '🔁', 'Giao dịch định kỳ')}${link('debts', '🤝', 'Sổ nợ')}${link('goals', '⭐', 'Mục tiêu tiết kiệm')}</div>
    <div class="sect">Dữ liệu</div><div class="card list">${link('data', '💾', 'Sao lưu / Nhập CSV')}</div>
    <div class="card list" style="margin-top:16px">${link('settings', '⚙️', 'Cài đặt & Mã PIN')}</div>`;
}

/* Danh mục */
function categoriesView() {
  const list = S.categories.filter(c => c.kind === UI.catKind).sort(byOrder);
  return `<div class="seg wide">${[['expense', 'Chi tiêu'], ['income', 'Thu nhập']].map(([v, n]) =>
    `<button class="${v === UI.catKind ? 'sel' : ''}" data-act="catKind" data-v="${v}">${n}</button>`).join('')}</div>
    <div class="card list">${list.map(c => `<div class="row" data-act="editCat" data-id="${c.id}">${ico(c.icon, c.color, 36)}<div class="grow">${esc(c.name)}</div>
      <small>${S.tx.filter(t => t.catId === c.id).length}</small></div>`).join('')}</div>
    <p class="note">Xóa danh mục sẽ chuyển các giao dịch của nó sang "Chưa phân loại" và xóa ngân sách gắn với danh mục.</p>`;
}
function categorySheet(id) {
  const c = id ? catById(id) : null;
  let icon = c ? c.icon : '📦', color = c ? c.color : '#607D8B', kind = c ? c.kind : UI.catKind;
  const body = field('Tên danh mục', `<input id="f-name" value="${esc(c ? c.name : '')}" placeholder="Tên danh mục">`)
    + (c ? '' : seg('kind', [['expense', 'Chi tiêu'], ['income', 'Thu nhập']], kind))
    + `<div class="lbl">Biểu tượng</div>${emojiPicker(icon)}<div class="lbl">Màu sắc</div>${colorPicker(color)}`;
  openSheet(c ? 'Sửa danh mục' : 'Thêm danh mục', body, {
    onPick(g, v) { if (g === 'icon') icon = v; if (g === 'color') color = v; if (g === 'kind') kind = v; },
    onSave() {
      const name = $('#f-name').value.trim();
      if (!name) { toast('Nhập tên danh mục'); return false; }
      if (c) Object.assign(c, { name, icon, color });
      else S.categories.push({ id: uid(), name, icon, color, kind, order: S.categories.length });
      save();
    },
    onDelete: c ? () => {
      if (!confirm(`Xóa danh mục "${c.name}"?`)) return false;
      S.tx.forEach(t => { if (t.catId === c.id) t.catId = null; });
      S.recurring.forEach(r => { if (r.catId === c.id) r.catId = null; });
      S.budgets = S.budgets.filter(b => b.catId !== c.id);
      S.categories = S.categories.filter(x => x.id !== c.id);
      save();
    } : null
  });
}

/* Định kỳ */
function recurringView() {
  if (!S.recurring.length) return empty('Chưa có giao dịch định kỳ', 'Dùng cho tiền nhà, lương, đăng ký hàng tháng... App tự tạo giao dịch khi đến hạn.');
  const fname = Object.fromEntries(FREQS);
  return `<div class="card list">${S.recurring.map(r => {
    const c = catById(r.catId), w = walletById(r.walletId);
    return `<div class="row${r.active ? '' : ' dim'}" data-act="editRec" data-id="${r.id}">${ico(c ? c.icon : '🔁', c ? c.color : '#607D8B')}
      <div class="grow"><div>${esc(r.name)}</div><small>${fname[r.freq]} • Kế tiếp: ${shortDate(recurDate(r, r.occ))}${r.active ? '' : ' • Tạm dừng'}</small></div>
      <b class="${r.kind === 'income' ? 'pos' : 'neg'}">${r.kind === 'income' ? '+' : '-'}${money(r.amount, w ? w.currency : undefined)}</b></div>`;
  }).join('')}</div>`;
}
function recurringSheet(id) {
  const r = id ? S.recurring.find(x => x.id === id) : null;
  const ws = S.wallets.filter(w => !w.archived).sort(byOrder);
  let kind = r ? r.kind : 'expense', catId = r ? r.catId : null;
  const body = field('Tên (VD: Tiền nhà)', `<input id="f-name" value="${esc(r ? r.name : '')}">`)
    + seg('kind', [['expense', 'Chi tiêu'], ['income', 'Thu nhập']], kind)
    + field('Số tiền', `<input id="f-amount" class="big" inputmode="decimal" placeholder="0" value="${r ? plain(r.amount) : ''}">`)
    + `<div class="lbl">Danh mục</div><div id="catwrap">${catGrid(kind, catId)}</div>`
    + field('Ví', `<select id="f-wallet">${optionsHtml(ws.map(w => [w.id, `${w.name} (${w.currency})`]), r ? r.walletId : ws[0].id)}</select>`)
    + field('Lặp lại', `<select id="f-freq">${optionsHtml(FREQS, r ? r.freq : 'monthly')}</select>`)
    + field('Bắt đầu từ', `<input id="f-start" type="datetime-local" value="${toInputDT(r ? r.start : Date.now())}">`)
    + field('Ghi chú', `<input id="f-note" value="${esc(r ? r.note : '')}">`)
    + `<label class="check"><input type="checkbox" id="f-active" ${!r || r.active ? 'checked' : ''}> Đang hoạt động</label>`
    + `<p class="note">Nếu ngày bắt đầu nằm trong quá khứ khi tạo mới, app sẽ tạo bù các giao dịch đã đến hạn.</p>`;
  openSheet(r ? 'Sửa định kỳ' : 'Thêm định kỳ', body, {
    onPick(g, v) {
      if (g === 'kind') { kind = v; const c = catById(catId); if (c && c.kind !== kind) catId = null; $('#catwrap').innerHTML = catGrid(kind, catId); }
      else if (g === 'cat') catId = v;
    },
    onSave() {
      const name = $('#f-name').value.trim(), amount = parseNum($('#f-amount').value);
      if (!name) { toast('Nhập tên'); return false; }
      if (!(amount > 0)) { toast('Nhập số tiền hợp lệ'); return false; }
      if (!catId) { toast('Hãy chọn danh mục'); return false; }
      const data = { name, amount, kind, catId, walletId: $('#f-wallet').value, freq: $('#f-freq').value,
        start: fromInputDT($('#f-start').value), note: $('#f-note').value.trim(), active: $('#f-active').checked };
      if (r) {
        const changed = r.start !== data.start || r.freq !== data.freq;
        Object.assign(r, data);
        if (changed) fastForward(r);
      } else S.recurring.push(Object.assign({ id: uid(), occ: 0 }, data));
      processRecurring();
      save();
    },
    onDelete: r ? () => { if (!confirm('Xóa giao dịch định kỳ này? (Các giao dịch đã tạo vẫn được giữ)')) return false; S.recurring = S.recurring.filter(x => x.id !== r.id); save(); } : null
  });
}

/* Sổ nợ */
function debtsView() {
  const remain = d => Math.max(d.amount - d.paid, 0);
  const lend = S.debts.filter(d => !d.borrow && remain(d) > 0), borrow = S.debts.filter(d => d.borrow && remain(d) > 0);
  const done = S.debts.filter(d => remain(d) <= 0);
  const row = d => {
    const prog = d.amount > 0 ? Math.min(d.paid / d.amount, 1) : 0;
    const overdue = d.due && d.due < Date.now() && remain(d) > 0;
    return `<div class="row col${remain(d) <= 0 ? ' dim' : ''}" data-act="editDebt" data-id="${d.id}">
      <div class="rowtop"><b class="grow">${esc(d.person)}</b><b class="${d.borrow ? 'neg' : 'pos'}">${money(remain(d))}</b></div>${bar(prog, 'var(--accent)')}
      <div class="rowsub"><span>Đã ${d.borrow ? 'trả' : 'thu'} ${compact(d.paid)} / ${compact(d.amount)}</span>${d.due ? `<span class="${overdue ? 'neg' : ''}">Hạn: ${shortDate(d.due)}</span>` : ''}</div></div>`;
  };
  const sum = l => l.reduce((s, d) => s + remain(d), 0);
  return `<div class="card pad"><div class="strip two"><div><small>Phải thu</small><b class="pos">${compact(sum(lend))}</b></div><div><small>Phải trả</small><b class="neg">${compact(sum(borrow))}</b></div></div></div>
    ${!S.debts.length ? empty('Chưa có khoản nợ nào', 'Nhấn ＋ để ghi khoản cho vay hoặc đi vay.') : ''}
    ${lend.length ? `<div class="sect">Tôi cho vay (người khác nợ tôi)</div><div class="card list">${lend.map(row).join('')}</div>` : ''}
    ${borrow.length ? `<div class="sect">Tôi đi vay (tôi nợ)</div><div class="card list">${borrow.map(row).join('')}</div>` : ''}
    ${done.length ? `<div class="sect">Đã tất toán</div><div class="card list">${done.map(row).join('')}</div>` : ''}`;
}
function debtSheet(id) {
  const d = id ? S.debts.find(x => x.id === id) : null;
  let borrow = d ? d.borrow : false;
  const body = seg('type', [['lend', 'Tôi cho vay'], ['borrow', 'Tôi đi vay']], borrow ? 'borrow' : 'lend')
    + field('Người liên quan', `<input id="f-person" value="${esc(d ? d.person : '')}">`)
    + field(`Tổng khoản nợ (${S.settings.base})`, `<input id="f-amount" inputmode="decimal" value="${d ? plain(d.amount) : ''}" placeholder="0">`)
    + field('Đã trả / đã thu', `<input id="f-paid" inputmode="decimal" value="${d ? plain(d.paid) : '0'}">`)
    + (d ? `<button type="button" class="btn" id="f-settle">Đánh dấu đã tất toán</button>` : '')
    + field('Hạn thanh toán (có thể bỏ trống)', `<input id="f-due" type="date" value="${d && d.due ? toInputD(d.due) : ''}">`)
    + field('Ghi chú', `<input id="f-note" value="${esc(d ? d.note : '')}">`);
  openSheet(d ? 'Sửa khoản nợ' : 'Thêm khoản nợ', body, {
    onPick(g, v) { if (g === 'type') borrow = v === 'borrow'; },
    onSave() {
      const person = $('#f-person').value.trim(), amount = parseNum($('#f-amount').value);
      if (!person) { toast('Nhập tên người liên quan'); return false; }
      if (!(amount > 0)) { toast('Nhập số tiền hợp lệ'); return false; }
      const data = { person, amount, paid: parseNum($('#f-paid').value) || 0, borrow, due: fromInputD($('#f-due').value), note: $('#f-note').value.trim() };
      if (d) Object.assign(d, data); else S.debts.push(Object.assign({ id: uid(), start: Date.now() }, data));
      save();
    },
    onDelete: d ? () => { if (!confirm('Xóa khoản nợ này?')) return false; S.debts = S.debts.filter(x => x.id !== d.id); save(); } : null
  });
  const settle = $('#f-settle');
  if (settle) settle.onclick = () => { $('#f-paid').value = $('#f-amount').value; };
}

/* Mục tiêu */
function goalsView() {
  if (!S.goals.length) return empty('Chưa có mục tiêu', 'Đặt mục tiêu tiết kiệm và theo dõi tiến độ.');
  return `<div class="card list">${S.goals.map(g => {
    const prog = g.target > 0 ? Math.min(Math.max(g.saved / g.target, 0), 1) : 0;
    let need = '';
    if (g.deadline && g.deadline > Date.now() && g.target - g.saved > 0) {
      const months = Math.max(1, Math.round((g.deadline - Date.now()) / (30.44 * 864e5)));
      need = `<small class="muted">Cần tiết kiệm khoảng ${compact((g.target - g.saved) / months)}/tháng</small>`;
    }
    return `<div class="row col" data-act="editGoal" data-id="${g.id}">
      <div class="rowtop">${ico(g.icon, g.color)}<div class="grow"><b>${esc(g.name)}</b>${g.deadline ? `<br><small>Hạn: ${shortDate(g.deadline)}</small>` : ''}</div><b style="color:${g.color}">${pct(prog)}</b></div>
      ${bar(prog, g.color)}<div class="rowsub"><span>${money(g.saved)} / ${money(g.target)}</span>
      <button class="mini" data-act="topup" data-id="${g.id}">＋ Nạp tiền</button></div>${need}</div>`;
  }).join('')}</div>`;
}
function goalSheet(id) {
  const g = id ? S.goals.find(x => x.id === id) : null;
  let icon = g ? g.icon : '🎯', color = g ? g.color : '#FB8C00';
  const body = field('Tên mục tiêu', `<input id="f-name" value="${esc(g ? g.name : '')}">`)
    + field(`Số tiền mục tiêu (${S.settings.base})`, `<input id="f-target" inputmode="decimal" value="${g ? plain(g.target) : ''}" placeholder="0">`)
    + field('Đã tiết kiệm', `<input id="f-saved" inputmode="decimal" value="${g ? plain(g.saved) : '0'}">`)
    + field('Thời hạn (có thể bỏ trống)', `<input id="f-deadline" type="date" value="${g && g.deadline ? toInputD(g.deadline) : ''}">`)
    + `<div class="lbl">Biểu tượng</div>${emojiPicker(icon)}<div class="lbl">Màu sắc</div>${colorPicker(color)}`;
  openSheet(g ? 'Sửa mục tiêu' : 'Thêm mục tiêu', body, {
    onPick(k, v) { if (k === 'icon') icon = v; if (k === 'color') color = v; },
    onSave() {
      const name = $('#f-name').value.trim(), target = parseNum($('#f-target').value);
      if (!name) { toast('Nhập tên mục tiêu'); return false; }
      if (!(target > 0)) { toast('Nhập số tiền mục tiêu'); return false; }
      const data = { name, icon, color, target, saved: parseNum($('#f-saved').value) || 0, deadline: fromInputD($('#f-deadline').value) };
      if (g) Object.assign(g, data); else S.goals.push(Object.assign({ id: uid() }, data));
      save();
    },
    onDelete: g ? () => { if (!confirm('Xóa mục tiêu này?')) return false; S.goals = S.goals.filter(x => x.id !== g.id); save(); } : null
  });
}
function topupSheet(id) {
  const g = S.goals.find(x => x.id === id);
  if (!g) return;
  openSheet('Nạp tiền: ' + g.name, field('Số tiền (nhập số âm để rút)', `<input id="f-amount" class="big" inputmode="decimal" placeholder="0">`), {
    onSave() {
      const v = parseNum($('#f-amount').value);
      if (v == null || v === 0) { toast('Nhập số tiền hợp lệ'); return false; }
      g.saved += v; save();
    }
  });
}

/* Dữ liệu */
async function shareFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}
function dataView() {
  const b = S.settings.lastBackup;
  return `<div class="card list">
    <div class="row link" data-act="exportJSON"><span class="mi">🛟</span><div class="grow"><div>Sao lưu đầy đủ (JSON)</div><small>Mọi dữ liệu: ví, giao dịch, ngân sách, nợ, mục tiêu...</small></div></div>
    <div class="row link" data-act="importJSON"><span class="mi">♻️</span><div class="grow"><div>Khôi phục từ file JSON</div><small>Ghi đè toàn bộ dữ liệu hiện tại</small></div></div></div>
    <div class="card list" style="margin-top:16px">
    <div class="row link" data-act="exportCSV"><span class="mi">📤</span><div class="grow"><div>Xuất giao dịch ra CSV</div><small>Mở được bằng Excel / Google Sheets</small></div></div>
    <div class="row link" data-act="importCSV"><span class="mi">📥</span><div class="grow"><div>Nhập giao dịch từ CSV</div><small>Bỏ qua dòng trùng; tương thích bản iOS</small></div></div></div>
    <p class="note">Sao lưu gần nhất: <b>${b ? shortDate(b) : 'chưa có'}</b>. Dữ liệu chỉ nằm trên chiếc iPhone này; nếu xóa app hoặc xóa dữ liệu Safari thì sẽ mất. Hãy sao lưu định kỳ và lưu file vào iCloud Drive (chọn "Lưu vào Tệp").</p>
    <p class="note">Hiện có: ${S.wallets.length} ví, ${S.tx.length} giao dịch, ${S.categories.length} danh mục.</p>`;
}

/* Cài đặt */
function settingsView() {
  const s = S.settings;
  const others = CURRENCIES.filter(c => c !== s.base);
  return `<div class="sect">Tiền tệ chính</div><div class="card pad">${field('Tiền tệ', `<select id="base">${optionsHtml(CURRENCIES.map(c => [c, c]), s.base)}</select>`)}</div>
    <div class="sect">Tỷ giá quy đổi</div><div class="card pad">
    ${others.map(c => `<div class="rate"><span>1 ${c} =</span><input data-rate="${c}" inputmode="decimal" value="${plain(s.rates[c] || 1)}"><span>${s.base}</span></div>`).join('')}</div>
    <p class="note">Dùng để cộng tổng số dư và báo cáo khi có ví ngoại tệ. Đổi tiền tệ chính thì cần nhập lại tỷ giá.</p>
    <div class="sect">Bảo mật</div><div class="card list">
    ${s.pinHash ? `<div class="row link" data-act="setPin"><span class="mi">🔐</span><div class="grow">Đổi mã PIN</div></div>
      <div class="row link" data-act="lockNow"><span class="mi">🔒</span><div class="grow">Khóa ngay</div></div>
      <div class="row link" data-act="offPin"><span class="mi">🔓</span><div class="grow">Tắt mã PIN</div></div>`
      : `<div class="row link" data-act="setPin"><span class="mi">🔐</span><div class="grow">Đặt mã PIN khóa app</div></div>`}</div>
    ${s.pinHash ? `<div class="card pad">${field('Tự khóa khi rời app', `<select id="lockafter">${optionsHtml([[0, 'Ngay lập tức'], [60, 'Sau 1 phút'], [300, 'Sau 5 phút'], [900, 'Sau 15 phút']], s.lockAfter)}</select>`)}</div>` : ''}
    <p class="note">Mã PIN chỉ khóa giao diện app, không mã hóa dữ liệu trong bộ nhớ. Hãy kết hợp với mật khẩu/Face ID của iPhone.</p>
    <div class="card list" style="margin-top:16px"><div class="row link" data-act="wipe"><span class="mi">🗑️</span><div class="grow neg">Xóa toàn bộ dữ liệu</div></div></div>
    <p class="note">Phiên bản web app 1.0</p>`;
}
function pinSheet() {
  const body = field('Mã PIN mới (4–6 chữ số)', `<input id="f-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off">`)
    + field('Nhập lại mã PIN', `<input id="f-pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off">`);
  openSheet(S.settings.pinHash ? 'Đổi mã PIN' : 'Đặt mã PIN', body, {
    onSave() {
      const a = $('#f-pin').value, b = $('#f-pin2').value;
      if (!/^\d{4,6}$/.test(a)) { toast('PIN gồm 4–6 chữ số'); return false; }
      if (a !== b) { toast('Hai lần nhập không khớp'); return false; }
      setPin(a).then(() => { toast('Đã đặt mã PIN'); render(); });
    }
  });
}

/* ---------- Khóa PIN ---------- */
let lockBuf = '', hiddenAt = 0, lockBusy = false;
function drawDots() {
  $('#dots').innerHTML = Array.from({ length: S.settings.pinLen }, (_, i) => `<i class="${i < lockBuf.length ? 'on' : ''}"></i>`).join('');
}
function showLock() {
  if (!S.settings.pinHash) return;
  lockBuf = ''; lockBusy = false;
  $('#lock-msg').textContent = 'Nhập mã PIN';
  $('#lock').hidden = false;
  document.body.classList.add('locked');
  drawDots();
}
function hideLock() { $('#lock').hidden = true; document.body.classList.remove('locked'); }
async function lockKey(k) {
  if (lockBusy) return;
  if (k === 'del') lockBuf = lockBuf.slice(0, -1);
  else if (lockBuf.length < S.settings.pinLen) lockBuf += k;
  drawDots();
  if (lockBuf.length === S.settings.pinLen) {
    lockBusy = true;
    if (await checkPin(lockBuf)) { hideLock(); }
    else {
      $('#lock-msg').textContent = 'Sai mã PIN, thử lại';
      $('#dots').classList.add('shake');
      setTimeout(() => { $('#dots').classList.remove('shake'); lockBuf = ''; drawDots(); lockBusy = false; }, 450);
    }
  }
}
function initLock() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'forgot', '0', 'del'];
  $('#keypad').innerHTML = keys.map(k => k === 'forgot' ? '<span></span>' : `<button type="button" data-k="${k}">${k === 'del' ? '⌫' : k}</button>`).join('');
  $('#keypad').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) lockKey(b.dataset.k); });
  $('#forgot').onclick = async () => {
    if (!confirm('Quên PIN: cách duy nhất là XÓA TOÀN BỘ dữ liệu trên máy rồi khôi phục từ file sao lưu JSON. Tiếp tục?')) return;
    await wipeAll();
    hideLock();
    UI.tab = 'tx'; UI.sub = null;
    render();
    toast('Đã xóa dữ liệu. Vào Khác > Sao lưu để khôi phục.');
  };
}

/* ---------- Routes & render ---------- */
const plus = act => `<button class="ibtn" data-act="${act}" aria-label="Thêm">＋</button>`;
const ROUTES = {
  tx: { title: 'Giao dịch', html: txView, actions: () => plus('addTx') },
  wallets: { title: 'Ví', html: walletsView, actions: () => `<button class="tbtn" data-act="transfer">⇄ Chuyển</button>${plus('addWallet')}` },
  budgets: { title: 'Ngân sách', html: budgetsView, actions: () => plus('addBudget') },
  reports: { title: 'Báo cáo', html: reportsView },
  more: { title: 'Khác', html: moreView },
  categories: { title: 'Danh mục', html: categoriesView, actions: () => plus('addCat') },
  recurring: { title: 'Giao dịch định kỳ', html: recurringView, actions: () => plus('addRec') },
  debts: { title: 'Sổ nợ', html: debtsView, actions: () => plus('addDebt') },
  goals: { title: 'Mục tiêu tiết kiệm', html: goalsView, actions: () => plus('addGoal') },
  data: { title: 'Sao lưu / Nhập CSV', html: dataView },
  settings: { title: 'Cài đặt', html: settingsView }
};
let lastRoute = null;
function render() {
  const key = UI.sub || UI.tab;
  const r = ROUTES[key];
  const v = $('#view');
  const st = lastRoute === key ? v.scrollTop : 0;
  $('#title').textContent = r.title;
  $('#back').hidden = !UI.sub;
  $('#actions').innerHTML = r.actions ? r.actions() : '';
  v.innerHTML = r.html();
  v.scrollTop = st;
  lastRoute = key;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === UI.tab));
}

/* ---------- Xử lý sự kiện ---------- */
const H = {
  tab(d) { UI.tab = d.tab; UI.sub = null; render(); },
  back() { UI.sub = null; render(); },
  open(d) { UI.sub = d.sub; render(); },
  goData() { UI.tab = 'more'; UI.sub = 'data'; render(); },
  mprev(d) { UI[d.k] = addMonths(UI[d.k], -1); render(); },
  mnext(d) { UI[d.k] = addMonths(UI[d.k], 1); render(); },
  addTx() { txSheet(); }, editTx(d) { txSheet(d.id); },
  addWallet() { walletSheet(); }, editWallet(d) { walletSheet(d.id); }, transfer() { transferSheet(); },
  addBudget() { budgetSheet(); }, editBudget(d) { budgetSheet(d.id); },
  repKind(d) { UI.repKind = d.v; render(); },
  catKind(d) { UI.catKind = d.v; render(); },
  addCat() { categorySheet(); }, editCat(d) { categorySheet(d.id); },
  addRec() { recurringSheet(); }, editRec(d) { recurringSheet(d.id); },
  addDebt() { debtSheet(); }, editDebt(d) { debtSheet(d.id); },
  addGoal() { goalSheet(); }, editGoal(d) { goalSheet(d.id); }, topup(d, el, e) { e.stopPropagation(); topupSheet(d.id); },
  async exportCSV() {
    const ok = await shareFile(`sothuchi-${toInputDT(Date.now()).replace(/[-:T]/g, '').slice(0, 12)}.csv`, exportCSV(), 'text/csv');
    if (ok) { S.settings.lastBackup = Date.now(); save(); render(); }
  },
  async exportJSON() {
    const ok = await shareFile(`sothuchi-backup-${toInputDT(Date.now()).replace(/[-:T]/g, '').slice(0, 12)}.json`, exportJSON(), 'application/json');
    if (ok) { S.settings.lastBackup = Date.now(); save(); render(); }
  },
  importCSV() { UI.importKind = 'csv'; $('#file-in').click(); },
  importJSON() { UI.importKind = 'json'; $('#file-in').click(); },
  setPin() { pinSheet(); },
  lockNow() { showLock(); },
  offPin() { if (confirm('Tắt mã PIN?')) { clearPin(); render(); toast('Đã tắt mã PIN'); } },
  async wipe() {
    if (!confirm('XÓA TOÀN BỘ dữ liệu? Không thể hoàn tác. Hãy sao lưu trước nếu cần.')) return;
    if (!confirm('Chắc chắn xóa tất cả?')) return;
    await wipeAll(); UI.sub = null; UI.tab = 'tx'; render(); toast('Đã xóa dữ liệu');
  }
};

function initEvents() {
  document.addEventListener('click', e => {
    if (e.target.closest('#sheet-backdrop') && !e.target.closest('#view')) return;
    const el = e.target.closest('[data-act]');
    if (!el || !H[el.dataset.act]) return;
    H[el.dataset.act](el.dataset, el, e);
  });
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) H.tab(b.dataset); });
  $('#back').onclick = () => H.back();

  const view = $('#view');
  view.addEventListener('input', e => {
    if (e.target.id === 'search') { UI.search = e.target.value; $('#txlist').innerHTML = txListHtml(); }
  });
  view.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'wfilter') { UI.wfilter = t.value; render(); }
    else if (t.id === 'base') { S.settings.base = t.value; save(); render(); }
    else if (t.id === 'lockafter') { S.settings.lockAfter = +t.value; save(); }
    else if (t.dataset && t.dataset.rate) {
      const v = parseNum(t.value);
      if (v && v > 0) { S.settings.rates[t.dataset.rate] = v; save(); }
    }
  });

  $('#file-in').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      if (UI.importKind === 'csv') {
        const r = importCSV(text);
        toast(`Đã nhập ${r.imported} giao dịch, bỏ qua ${r.skipped} dòng`);
      } else {
        if (!confirm('Khôi phục sẽ GHI ĐÈ toàn bộ dữ liệu hiện tại. Tiếp tục?')) return;
        await importJSON(text);
        toast('Đã khôi phục dữ liệu');
      }
      render();
    } catch (err) { alert('Lỗi: ' + err.message); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); flush(); return; }
    if (S.settings.pinHash && Date.now() - hiddenAt >= S.settings.lockAfter * 1000) showLock();
    if (processRecurring() && !sheetState) render();
  });
  window.addEventListener('pagehide', flush);
}

/* ---------- Khởi động ---------- */
async function boot() {
  await loadState();
  initSheet(); initLock(); initEvents();
  processRecurring();
  render();
  if (S.settings.pinHash) showLock();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloading) { reloading = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW lỗi', err));
  }
}
boot();
