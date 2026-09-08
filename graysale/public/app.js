/* GraySale — Retail Management SPA */
(() => {
'use strict';

// ---------- tiny DOM helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- money ----------
const fmtCents = (c, sym = '$') => {
  if (c == null) c = 0;
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(Math.round(c));
  return `${sign}${sym}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
};
const toCents = (v) => Math.round((Number(v) || 0) * 100);

const badgeFor = (status) => {
  const map = {
    PAID: ['badge-green', 'Paid'], OPEN: ['badge-amber', 'Open'], PARTIAL: ['badge-blue', 'Partial'],
    COMPLETED: ['badge-green', 'Done'], VOID: ['badge-red', 'Void'], DRAFT: ['badge-gray', 'Draft'],
    ORDERED: ['badge-blue', 'Ordered'], RECEIVED: ['badge-green', 'Received'], CONVERTED: ['badge-gray', 'Converted'],
  };
  const [cls, txt] = map[status] || ['badge-gray', status || '—'];
  return `<span class="badge ${cls}">${txt}</span>`;
};
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

// ---------- state ----------
let TOKEN = localStorage.getItem('rm_token') || '';
let USER = null;
let SETTINGS = { company: 'GraySale', address: '', phone: '', tin: '', currency: '$', taxName: 'VAT', termsDays: 14, fiscal: false, cashDrawer: false };
let PRINTERS = [];
let CATALOG = { products: [], categories: [], customers: [] }; // cached
let nav = 'pos';
let sidebarRenders = {}; // view name -> sidebar html

// ---------- api ----------
async function api(method, path, body) {
  const opts = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api/v1' + path, opts);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const e = new Error(data.error || data.message || `HTTP ${res.status}`);
    e.status = res.status; e.code = data.code; e.data = data;
    throw e;
  }
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);
const put = (p, b) => api('PUT', p, b);
const del = (p) => api('DELETE', p);

// ---------- toast ----------
function toast(msg, kind = '') {
  let wrap = $('#toast-wrap');
  if (!wrap) { wrap = el('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = el('div', `toast ${kind}`, esc(msg));
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
}

// ---------- modal ----------
function modal({ title, body, footer, onMount, wide }) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const scrim = el('div', 'scrim');
  const box = el('div', `modal${wide ? ' modal-wide' : ''}`);
  box.style.width = wide ? '880px' : '';
  const hd = el('div', 'modal-hd', `<span>${esc(title)}</span>`);
  const close = el('button', 'modal-close', '×');
  close.onclick = closeModal;
  hd.appendChild(close);
  const bd = el('div', 'modal-bd');
  bd.innerHTML = body;
  box.append(hd, bd);
  if (footer) { const ft = el('div', 'modal-ft'); ft.innerHTML = footer; box.appendChild(ft); }
  scrim.appendChild(box);
  root.appendChild(scrim);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
  document.addEventListener('keydown', escHandler);
  if (onMount) onMount(bd, box);
  return box;
}
function closeModal() {
  document.removeEventListener('keydown', escHandler);
  $('#modal-root').innerHTML = '';
}
function escHandler(e) { if (e.key === 'Escape') closeModal(); }

// ---------- customizable category modal helper ----------
// options: { title, placeholder, defaultName, autoSelect (bool), extraFieldsHtml, onCreate }
async function openCategoryModal(options = {}) {
  const opts = Object.assign({ title: 'Add category', placeholder: '', defaultName: '', autoSelect: true, extraFieldsHtml: '', onCreate: null }, options);
  modal({
    title: opts.title,
    body: `<div class="field"><label>Category name</label><input id="new-cat-name" autofocus placeholder="${esc(opts.placeholder)}" value="${esc(opts.defaultName)}"></div>${opts.extraFieldsHtml}`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button>
             <button class="btn btn-primary" id="new-cat-save">Create</button>`,
    onMount: (bd) => {
      $('#new-cat-save').onclick = async () => {
        const name = $('#new-cat-name').value.trim();
        if (!name) return toast('Enter a name', 'warn');
        try {
          const created = await post('/categories', { name });
          await loadCatalog();
          // update any visible category select named p-cat
          const sel = $('#p-cat');
          if (sel) {
            sel.innerHTML = '<option value="">— None —</option>' + CATALOG.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
            if (opts.autoSelect) {
              // prefer returned id, fallback to matching name
              const id = created?.id || (CATALOG.categories.find(c => c.name === name) || {}).id;
              if (id) {
                sel.value = id;
                sel.dispatchEvent(new Event('change'));
              }
            }
          }
          if (typeof opts.onCreate === 'function') {
            try { opts.onCreate(created); } catch (_) {}
          }
          toast('Category added', 'ok');
          closeModal();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function updateCategoryDisplays() {
  try {
    // Update all selects that opt into category updates
    $$('.cat-select').forEach(sel => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">— None —</option>' + CATALOG.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('') + `<option value="__add_new__" class="font-semibold">+ Add New Category...</option>`;
      if (cur) sel.value = cur;
    });

    // Update POS category buttons if present
    $$('.pos-cats').forEach(pc => {
      pc.innerHTML = `<button class="pos-cat-btn ${posCategory === 'all' ? 'active' : ''}" data-cat="all">All</button>` + CATALOG.categories.map(c => `<button class="pos-cat-btn ${posCategory == c.id ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('');
      $$('.pos-cat-btn', pc).forEach(b => b.onclick = () => { posCategory = b.dataset.cat; if (RM_VIEWS.pos && typeof RM_VIEWS.pos.render === 'function') RM_VIEWS.pos.render($('#content')); });
    });

    // Trigger change on product category select if present
    const pc = $('#p-cat'); if (pc) pc.dispatchEvent(new Event('change'));
  } catch (e) { /* ignore UI update errors */ }
}


// ---------- login ----------
async function doLogin(u, p) {
  const r = await post('/auth/login', { username: u, password: p });
  if (!r.ok) throw new Error(r.error || 'Login failed');
  TOKEN = r.token; USER = r.user;
  localStorage.setItem('rm_token', TOKEN);
  showApp();
}
async function doLogout() { try { await post('/auth/logout'); } catch (_) {} TOKEN = ''; USER = null; localStorage.removeItem('rm_token'); location.reload(); }

// ---------- shell ----------
function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#tb-username').textContent = USER?.fullName || USER?.username || '';
  bindNav();
  loadSettings().then(() => navigate(nav));
}

function bindNav() {
  $$('#menu .menu-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.nav)));
  $('#btn-logout').addEventListener('click', doLogout);
  $('#btn-user').addEventListener('click', () => userMenu());
}

async function loadSettings() {
  try {
    SETTINGS = await get('/settings');
    document.title = `${SETTINGS.company || 'GraySale'} · Retail Management`;
    try { PRINTERS = await get('/printers'); } catch (_) {}
  } catch (_) {}
}

function navigate(name) {
  nav = name;
  $$('#menu .menu-item').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  const sb = $('#sidebar-content');
  sb.innerHTML = '';
  const views = window.RM_VIEWS;
  if (!views[name]) name = 'dashboard';
  nav = name;
  if (views[name]) {
    setStatus(`Loading ${name}…`);
    const mt = $('#module-title'); if (mt) mt.textContent = views[name].label || name;
    sb.innerHTML = views[name].sidebar || '';
    $$('.sb-btn', sb).forEach(b => b.addEventListener('click', () => views[name].go && views[name].go(b.dataset.action)));
    const r = views[name].render($('#content'));
    if (r && typeof r.then === 'function') r.finally(() => setStatus('Ready'));
    else setStatus('Ready');
    return;
  }
  setStatus('Ready');
}

function setStatus(msg) { $('#sb-left').textContent = msg; }

function refreshClock() {
  const c = $('#tb-clock');
  if (c) c.textContent = new Date().toLocaleTimeString('en-GB');
}
setInterval(refreshClock, 1000);

async function userMenu() {
  modal({
    title: `User — ${USER.username}`,
    body: `
      <div class="fields-2">
        <div class="field"><label>Full name</label><div>${esc(USER.fullName || USER.username)}</div></div>
        <div class="field"><label>Role</label><div>${esc(USER.role)}</div></div>
      </div>
      <p class="muted" style="margin-top:12px">Change password below.</p>
      <div class="fields-2" style="margin-top:8px">
        <div class="field"><label>New password</label><input type="password" id="pw1"></div>
        <div class="field"><label>Confirm</label><input type="password" id="pw2"></div>
      </div>`,
    footer: `<button class="btn" onclick="closeModal()">Close</button>
             <button class="btn btn-primary" id="pw-save">Save password</button>`,
    onMount: (bd) => {
      $('#pw-save').onclick = async () => {
        const p1 = $('#pw1').value, p2 = $('#pw2').value;
        if (!p1) return toast('Enter a password', 'warn');
        if (p1 !== p2) return toast('Passwords do not match', 'err');
        await put(`/users/${USER.id}`, { password: p1 });
        toast('Password updated', 'ok');
        closeModal();
      };
    },
  });
}

// ---------- generic table helper ----------
function renderTable(rows, cols, opts = {}) {
  const { empty = 'No records', rowId = (r, i) => i } = opts;
  if (!rows || !rows.length) return `<div class="panel" style="padding:28px; text-align:center; color:var(--ink-3)">${esc(empty)}</div>`;
  const thead = cols.map(c => `<th class="${c.num ? 'num' : ''}" style="${c.width ? `width:${c.width}` : ''}">${esc(c.label)}</th>`).join('');
  const tbody = rows.map((r, i) => {
    const tds = cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r, i) : esc(r[c.key])}</td>`).join('');
    return `<tr data-id="${esc(rowId(r, i))}">${tds}</tr>`;
  }).join('');
  return `<div class="panel"${opts.panelId ? ` id="${opts.panelId}"` : ''}><div class="grid-wrap"><table class="grid zebra">${opts.caption ? `<caption class="panel-hd" style="font-size:12px">${esc(opts.caption)}</caption>` : ''}<thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div></div>`;
}

// ---------- PAGELET: dashboard ----------
async function dashView(container) {
  setStatus('Loading dashboard…');
  try {
    const [dash, low] = await Promise.all([get('/dashboard'), get('/products/low')]);
    const s = SETTINGS.currency;
    const today = dash.today;
    container.innerHTML = `
      <div class="page-header"><div><h2>Dashboard</h2><div class="subtitle">${esc(SETTINGS.company)} · ${fmtDate(new Date().toISOString())}</div></div></div>
      <div class="stat-cards">
        <div class="stat-card"><div class="k">Sales today</div><div class="v">${fmtCents(today.netSales, s)}</div><div class="d">${today.saleCount} transactions</div></div>
        <div class="stat-card"><div class="k">Gross sales</div><div class="v">${fmtCents(today.grossSales, s)}</div></div>
        <div class="stat-card"><div class="k">Refunds</div><div class="v" style="color:var(--red)">${fmtCents(today.refundTotal, s)}</div><div class="d">${today.refunds} returned</div></div>
        <div class="stat-card"><div class="k">Low stock items</div><div class="v" style="color:${dash.lowStock.length ? 'var(--amber)' : 'var(--green)'}">${dash.lowStock.length}</div></div>
      </div>
      <div class="fields-2" style="grid-template-columns: 3fr 2fr; gap:12px;">
        ${renderTable(dash.byDay || [], [
          { key: 'day', label: 'Date' }, { key: 'count', label: 'Sales', num: true },
          { key: 'sales', label: 'Amount', num: true, render: (r) => fmtCents(r.sales, s) },
          { key: 'refunds', label: 'Refunds', num: true, render: (r) => fmtCents(r.refunds, s) },
        ], { empty: 'No sales yet', panelId: 'dash-sales' })}
        ${renderTable(dash.lowStock || [], [
          { key: 'name', label: 'Product' }, { key: 'sku', label: 'SKU' },
          { key: 'qty_on_hand', label: 'On hand', num: true },
          { key: 'reorder_level', label: 'Reorder', num: true },
          { key: 'price_cents', label: 'Price', num: true, render: (r) => fmtCents(r.price_cents, s) },
        ], { empty: 'Nothing low', panelId: 'dash-low' })}
      </div>`;
  } catch (e) {
    container.innerHTML = `<div class="panel" style="padding:30px;color:var(--red)">Dashboard error: ${esc(e.message)}</div>`;
  }
}

const RM_VIEWS = {};
RM_VIEWS.dashboard = { label: 'Dashboard', render: dashView, sidebar: '' };

// ---------- dealer: view router wiring ----------
window.RM_VIEWS = RM_VIEWS;

// ============================================================
// POS
// ============================================================
let cart = []; // {productId, name, qty, unit, stock}
let posCustomer = null;
let posCategory = 'all';
const posActions = {}; // populated by posView for sidebar action buttons

async function loadCatalog() {
  CATALOG.products = await get('/products');
  CATALOG.categories = await get('/categories');
  CATALOG.customers = await get('/customers');
  try { updateCategoryDisplays(); } catch (_) {}
}

function computeTotals() {
  // per-line tax
  let subtotal = 0;
  let tax = 0;
  for (const l of cart) {
    const p = CATALOG.products.find(x => x.id === l.productId);
    const rate = (p?.tax_rate_bps) || 0;
    const line = l.unit * l.qty;
    subtotal += line;
    tax += Math.round(line * rate / 10000);
  }
  return { subtotal, discount: 0, tax, total: subtotal + tax };
}

function posSidebar() {
  return `
    <div class="sb-title">Actions</div>
    <button class="sb-btn" data-action="clear">Clear cart</button>
    <button class="sb-btn" data-action="pay">Charge / Pay</button>
    <button class="sb-btn" data-action="layaway">Layaway deposit</button>
    <button class="sb-btn" data-action="quote">Quote</button>
    <div class="sb-title">Other</div>
    <button class="sb-btn" data-action="orders">Today's orders</button>
    <button class="sb-btn" data-action="void">Refund / void</button>
    <button class="sb-btn" data-action="refresh">Refresh stock</button>`;
}

// ============================================================
// RECEIPT BUILDER (global — used by printReceipt and testPrint)
// ============================================================
function buildReceiptHTML(sale, printer) {
  const isFiscal = printer ? !!printer.fiscal : SETTINGS.fiscal;
  const cur = SETTINGS.currency;
  const now = new Date();
  const title = isFiscal ? 'TAX INVOICE' : 'RECEIPT';

  // demo receipt if no sale (test print)
  const demo = !sale;
  const docNo = sale?.doc_no || 'DEMO-00000';
  const dt = sale?.created_at || now.toISOString();
  const cashier = sale ? (USER?.username || '') : (USER?.username || 'cashier');
  const customer = sale?.customer_name || 'Walk-in';
  const lines = sale?.lines || [
    { product_name: 'Sample Item 1', qty: 2, unit_price_cents: 150, line_total_cents: 300, tax_cents: 45 },
    { product_name: 'Sample Item 2', qty: 1, unit_price_cents: 80, line_total_cents: 80, tax_cents: 12 },
  ];
  const subtotal = sale?.subtotal_cents ?? 380;
  const taxTotal = sale?.tax_cents ?? 57;
  const total = sale?.total_cents ?? 437;
  const tendered = sale ? ((sale.paid_cents || 0) + (sale.change || 0)) : 500;
  const change = sale?.change || 63;

  const lineItems = lines.map(l => `
    <tr>
      <td>${esc(l.product_name)}</td>
      <td class="r">${l.qty}x</td>
      <td class="r">${fmtCents(l.unit_price_cents ?? (l.line_total_cents / l.qty), cur)}</td>
      <td class="r">${fmtCents(l.line_total_cents, cur)}</td>
    </tr>`).join('');

  const fiscalBlock = isFiscal ? `
    <div class="fiscal-block">
      <img src="data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#000"/><text x="50" y="55" text-anchor="middle" fill="#fff" font-size="10">QR CODE</text></svg>')}" alt="QR" style="width:80px;height:80px;margin:6px auto;display:block">
      <div>Device: ${esc(printer?.fiscal_serial || 'TCA-XXXX')}</div>
      <div>Fiscal Receipt: ${esc(sale?.fiscal_no || 'Rx-XXXXXXX-XX')}</div>
      <div style="font-size:8px;word-break:break-all">Hash: ${esc(sale?.fiscal_hash || 'a1b2c3d4e5f6...')}</div>
      <div>FDMS: fdms.zimra.co.zw</div>
    </div>` : '';

  const drawerKick = (printer?.cash_drawer || SETTINGS.cashDrawer) && sale ? '\x1B\x70\x00\x19\xFA' : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title} ${docNo}</title>
<style>
  @page { size: 80mm auto; margin: 2mm; }
  @media print { body { margin: 0; } }
  @page.fiscal { size: 80mm auto; }
  @page.a4 { size: A4 portrait; margin: 15mm; }
  @page.58mm { size: 58mm auto; margin: 2mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', 'Consolas', monospace; font-size: 12px; color: #000; width: ${printer?.type === '58mm' ? '54' : '76'}mm; padding: 0 2mm; }
  ${printer?.type === 'A4' ? 'body { width: 100%; max-width: 210mm; font-size: 11px; }' : ''}
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .company { font-size: 16px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
  .sub { font-size: 10px; color: #444; }
  .title { font-size: 14px; font-weight: 700; margin: 4px 0; text-transform: uppercase; }
  hr { border: none; border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 2px 0; font-size: 11px; }
  th { border-bottom: 1px solid #000; text-align: left; font-size: 10px; }
  .r { text-align: right; }
  .totals td { padding: 1px 0; }
  .total-row td { border-top: 1px solid #000; font-weight: 700; font-size: 13px; padding-top: 3px; }
  .fiscal-block { margin-top: 6px; border-top: 1px dashed #000; padding-top: 4px; font-size: 9px; text-align: center; }
  .thank { margin-top: 8px; font-size: 11px; text-transform: uppercase; }
  @media screen { body { border: 1px solid #ccc; padding: 12px; margin: 10px auto; max-width: 320px; background: #fff; } }
</style>
</head>
<body>
  <div class="center company">${esc(SETTINGS.company || 'Store')}</div>
  ${SETTINGS.address ? `<div class="center sub">${esc(SETTINGS.address)}</div>` : ''}
  ${SETTINGS.phone || SETTINGS.tin ? `<div class="center sub">${SETTINGS.phone ? 'Tel: ' + esc(SETTINGS.phone) : ''}${SETTINGS.tin ? (SETTINGS.phone ? ' · ' : '') + 'TIN: ' + esc(SETTINGS.tin) : ''}</div>` : ''}
  <div class="center title">${title}</div>
  <hr>
  <div>Receipt: <b>${esc(docNo)}</b></div>
  <div>Date: ${fmtDT(dt)}</div>
  <div>Cashier: ${esc(cashier)}</div>
  ${sale?.customer_name ? `<div>Customer: ${esc(customer)}</div>` : ''}
  <hr>
  <table>
    <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th></tr></thead>
    <tbody>${lineItems}</tbody>
  </table>
  <hr>
  <table class="totals">
    <tr><td>Subtotal</td><td class="r">${fmtCents(subtotal, cur)}</td></tr>
    <tr><td>${esc(SETTINGS.taxName)} (${(15)}%)</td><td class="r">${fmtCents(taxTotal, cur)}</td></tr>
    <tr class="total-row"><td>TOTAL</td><td class="r">${fmtCents(total, cur)}</td></tr>
  </table>
  <hr>
  <div style="display:flex;justify-content:space-between"><span>Tendered:</span><span>${fmtCents(tendered, cur)}</span></div>
  ${change > 0 ? `<div style="display:flex;justify-content:space-between"><span>Change:</span><span class="bold">${fmtCents(change, cur)}</span></div>` : ''}
  <hr>
  ${fiscalBlock}
  <div class="center thank">*** Thank you ***</div>
  ${demo ? '<div class="center sub" style="margin-top:4px">— DEMO RECEIPT —</div>' : ''}
</body></html>`;
}

// ============================================================
// POS
// ============================================================
async function posView(container) {
  if (!CATALOG.products.length) await loadCatalog();
  const startTime = Date.now();

  function render() {
    const filtered = posCategory === 'all'
      ? CATALOG.products
      : CATALOG.products.filter(p => p.category_id == posCategory);
    const totals = computeTotals();

    const cartRows = cart.length ? cart.map((l, i) => `
      <div class="pos-cart-row" data-ci="${i}">
        <span class="muted">${i + 1}</span>
        <div><div style="font-weight:600">${esc(l.name)}</div><div class="muted" style="font-size:11px">${fmtCents(l.unit, SETTINGS.currency)}</div></div>
        <div class="qty"><button data-q="-1" data-ci="${i}">−</button><span style="font-weight:700">${l.qty}</span><button data-q="1" data-ci="${i}">+</button></div>
        <div class="num" style="font-weight:700">${fmtCents(l.unit * l.qty, SETTINGS.currency)}</div>
        <button class="modal-close" data-rm="${i}" style="font-size:15px">×</button>
      </div>`).join('')
      : `<div style="padding:24px; text-align:center; color:var(--ink-3)">Waiting for items…<br><span class="muted">Scan barcode or tap a product</span></div>`;

    const buttonsHTML = filtered.map(p => {
      const avail = p.qty_on_hand - p.qty_reserved;
      const low = avail <= p.reorder_level;
      return `<button class="quick-btn ${low ? 'low' : ''}" data-add="${p.id}">
        <span class="qb-name">${esc(p.name)}</span>
        <span class="qb-price">${fmtCents(p.price_cents, SETTINGS.currency)}</span>
        <span class="qb-stock">${avail} in stock</span>
      </button>`;
    }).join('');

    container.innerHTML = `
      <div class="pos-grid">
        <div class="pos-cart">
          <div class="pos-cart-hd">
            <span>Cart</span>
            <select id="pos-customer">
              <option value="">Walk-in customer</option>
              ${CATALOG.customers.map(c => `<option value="${c.id}"${posCustomer == c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="pos-cart-list">${cartRows}</div>
          <div class="pos-cart-totals">
            <div class="pos-total-line"><span>Subtotal</span><span>${fmtCents(totals.subtotal, SETTINGS.currency)}</span></div>
            <div class="pos-total-line"><span>${esc(SETTINGS.taxName)}</span><span>${fmtCents(totals.tax, SETTINGS.currency)}</span></div>
            <div class="pos-total-line big"><span>Total</span><span id="pos-total">${fmtCents(totals.total, SETTINGS.currency)}</span></div>
          </div>
          <div class="pos-pay-bar">
            <button class="btn btn-danger btn-sm" id="clear-cart">Clear</button>
            <button class="btn btn-success" id="btn-pay" style="font-size:15px; padding:10px 26px">Charge Now</button>
          </div>
        </div>
        <div class="pos-catalog">
          <input class="pos-search" id="pos-search" placeholder="Scan barcode or type to search…" autofocus>
          <div class="pos-cats">
            <button class="pos-cat-btn ${posCategory === 'all' ? 'active' : ''}" data-cat="all">All</button>
            ${CATALOG.categories.map(c => `<button class="pos-cat-btn ${posCategory == c.id ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}
          </div>
          <div class="pos-buttons">${buttonsHTML}</div>
        </div>
      </div>`;

    // wire events
    $('#pos-customer').onchange = (e) => posCustomer = e.target.value ? Number(e.target.value) : null;
    const searchEl = $('#pos-search');

    // Barcode scan / manual entry — primary path is Enter key
    searchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const raw = searchEl.value.trim();
      if (!raw) return;
      const q = raw.toLowerCase();

      // 1) Exact barcode match
      const byBarcode = CATALOG.products.find(x => x.barcode && x.barcode === raw);
      if (byBarcode) {
        const inCart = cart.find(l => l.productId === byBarcode.id);
        if (inCart) { inCart.qty += 1; }
        else { addToCart(byBarcode.id, 1); }
        searchEl.value = '';
        toast(`${byBarcode.name} x${inCart ? inCart.qty : 1}`, 'ok');
        render();
        return;
      }

      // 2) Exact SKU match
      const bySku = CATALOG.products.find(x => x.sku && x.sku.toLowerCase() === q);
      if (bySku) { addToCart(bySku.id, 1); searchEl.value = ''; render(); return; }

      // 3) Single name match
      const matches = CATALOG.products.filter(x => x.name.toLowerCase().includes(q));
      if (matches.length === 1) { addToCart(matches[0].id, 1); searchEl.value = ''; render(); return; }

      // 4) Not found
      toast(`No product found for "${raw}"`, 'warn');
    });

    // Live filter on keystroke (non-Enter)
    searchEl.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const str = q.length >= 2 ? q : '';
      $$('#content .pos-catalog .quick-btn').forEach(b => {
        const prod = CATALOG.products.find(x => x.id == b.dataset.add);
        b.style.display = (!str || (prod && (prod.name.toLowerCase().includes(str) || (prod.sku || '').toLowerCase().includes(str)))) ? '' : 'none';
      });
    });

    $$('[data-add]', container).forEach(b => b.onclick = () => addToCart(Number(b.dataset.add), 1));
    $$('[data-cat]', container).forEach(b => b.onclick = () => { posCategory = b.dataset.cat; render(); });
    $('#clear-cart').onclick = clearCart;
    $('#btn-pay').onclick = () => openPayment();
    $$('[data-q]', container).forEach(b => b.onclick = () => {
      const i = Number(b.dataset.ci);
      const d = Number(b.dataset.q);
      cart[i].qty = Math.max(1, cart[i].qty + d);
      render();
    });
    $$('[data-rm]', container).forEach(b => b.onclick = () => { cart.splice(Number(b.dataset.rm), 1); render(); });
    renderTotals();
  }

  function renderTotals() {
    const t = computeTotals();
    const tot = $('#pos-total');
    if (tot) tot.textContent = fmtCents(t.total, SETTINGS.currency);
    setStatus(`${cart.reduce((s, l) => s + l.qty, 0)} items · ${fmtCents(t.total, SETTINGS.currency)}`);
  }

  function addToCart(productId, qty) {
    const p = CATALOG.products.find(x => x.id === productId);
    if (!p) return toast('Product not found', 'err');
    const avail = p.qty_on_hand - p.qty_reserved;
    const inCart = cart.find(l => l.productId === productId);
    const cur = inCart ? inCart.qty : 0;
    if (cur + qty > avail) return toast(`Only ${avail} available`, 'warn');
    if (inCart) inCart.qty += qty;
    else cart.push({ productId, name: p.name, qty, unit: p.price_cents, stock: avail });
    posSearchClear();
    render();
  }

  function posSearchClear() { const s = $('#pos-search'); if (s) s.value = ''; }

  function clearCart() { if (cart.length && !confirm('Clear the whole cart?')) return; cart = []; posCustomer = null; render(); }

  function openPayment() {
    if (!cart.length) return toast('Cart is empty', 'warn');
    const { total: due } = computeTotals();
    const methods = ['CASH', 'CARD', 'MOBILE', 'BANK', 'CREDIT'];
    let selected = 'CASH';
    const amounts = {}; // cents per method

    const readField = () => { const inp = $('#pay-amount'); if (inp) amounts[selected] = toCents(inp.value); };
    const paid = () => Object.entries(amounts).filter(([k]) => k !== 'CREDIT').reduce((s, [, v]) => s + v, 0);
    const credited = () => amounts.CREDIT || 0;
    const tendered = () => paid() + credited();
    const remain = () => Math.max(0, due - tendered());
    const change = () => (paid() > due && !credited()) ? paid() - due : 0;
    const cust = () => posCustomer && CATALOG.customers.find(c => c.id === posCustomer);

    const renderPay = () => {
      const inputDefault = ((amounts[selected] ?? remain()) / 100).toFixed(2);
      const body = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px">
          <div class="muted">Amount due</div>
          <div style="font-size:28px; font-weight:800">${fmtCents(due, SETTINGS.currency)}</div>
        </div>
        <div class="pay-methods">
          ${methods.map(m => {
            return `<button class="pay-method ${selected === m ? 'active' : ''}" data-m="${m}">
              ${m}${m === 'CREDIT' ? '<span class="muted" style="font-size:10px">on account</span>' : ''}</button>`;
          }).join('')}
        </div>
        ${selected === 'CREDIT'
          ? `<div class="field"><label>Charge to account${cust() ? ` — ${esc(cust().name)}` : ' (no customer)'}</label>
              <input id="pay-amount" type="number" value="${inputDefault}" min="0" step="0.01"></div>`
          : `<div class="field"><label>${selected} tendered</label>
              <input id="pay-amount" type="number" value="${inputDefault}" min="0" step="0.01"></div>`}
        <div style="display:flex; justify-content:space-between; margin-top:14px; font-size:14px">
          <span>Tendered</span><span id="pay-tendered">${fmtCents(tendered(), SETTINGS.currency)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:14px">
          <span>Change</span><span id="pay-change" style="${change() ? 'color:var(--green);font-weight:700' : ''}">${fmtCents(change(), SETTINGS.currency)}</span>
        </div>
        ${remain() > 0 ? `<div style="margin-top:8px; font-size:13px; color:var(--amber)">Still due: ${fmtCents(remain(), SETTINGS.currency)}</div>` : ''}
        ${selected === 'CREDIT' && !cust() ? '<div style="margin-top:8px; font-size:12px; color:var(--ink-3)">Choose a customer to accept credit.</div>' : ''}`;

      modal({
        title: 'Payment', body, wide: false,
        footer: `<button class="btn" onclick="closeModal()">Cancel</button>
                 <button class="btn btn-primary" id="pay-confirm">Complete Sale</button>`,
        onMount: (bd) => {
          $$('.pay-method', bd).forEach(b => b.onclick = () => { readField(); selected = b.dataset.m; renderPay(); });
          $('#pay-amount')?.addEventListener('input', () => readField());
          $('#pay-confirm')?.addEventListener('click', async () => {
            readField();
            if (selected === 'CREDIT' && !posCustomer) return toast('Select a customer for credit sale', 'err');
            if (tendered() < due) return toast('Amount tendered is less than total', 'err');
            const amts = Object.entries(amounts).filter(([, v]) => v > 0).map(([m, v]) => ({ method: m, amount: v }));
            await completeSale(amts);
          });
        },
      });
    };
    renderPay();
  }

  async function completeSale(payments) {
    try {
      const body = {
        items: cart.map(l => ({ productId: l.productId, qty: l.qty })),
        payments: payments.filter(p => p.amount >= 0),
        customerId: posCustomer || null,
      };
      const r = await post('/pos/sell', body);
      toast(`Sale ${r.doc_no} complete${r.change > 0 ? ` (change ${fmtCents(r.change, SETTINGS.currency)})` : ''}`, 'ok');
      if (CATALOG.products.length) await loadCatalog();
      cart = []; posCustomer = null;
      closeModal();
      printReceipt(r);
      render();
    } catch (e) { toast(e.message, 'err'); }
  }

  function printReceipt(sale) {
    const printer = PRINTERS.find(p => p.is_default) || PRINTERS[0] || null;
    const html = buildReceiptHTML(sale, printer);
    const w = window.open('', '_blank', 'width=340,height=600');
    if (!w) { toast('Pop-up blocked — allow pop-ups to print', 'warn'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 350);
  }

  Object.assign(posActions, { clearCart, openPayment });
  render();
}

// ============================================================
// STOCK
// ============================================================
async function stockView(container) {
  try {
    const [products, movs] = await Promise.all([get('/products'), get('/inventory/movements')]);
    const search = '';
    const s = SETTINGS.currency;
    const filtered = products;
    container.innerHTML = `
      <div class="page-header">
        <div><h2>Stock / Product Catalogue</h2><div class="subtitle">${products.length} products · ${products.filter(p => p.qty_on_hand - p.qty_reserved <= p.reorder_level).length} low</div></div>
        <div class="toolbar">
          <input class="search-input" id="stk-search" placeholder="Search name / SKU / barcode…">
          <button class="btn btn-primary" id="stk-add">+ New product</button>
          <button class="btn" id="stk-adjust">Adjust stock</button>
        </div>
      </div>
      ${renderTable(products, [
        { key: 'name', label: 'Product', render: (r) => `<div style="font-weight:600">${esc(r.name)}</div><div class="muted" style="font-size:11px">${esc(r.sku)}</div>` },
        { key: 'barcode', label: 'Barcode', render: (r) => esc(r.barcode || '—') },
        { key: 'category_name', label: 'Category' },
        { key: 'price_cents', label: 'Price', num: true, render: (r) => fmtCents(r.price_cents, s) },
        { key: 'cost_cents', label: 'Cost', num: true, render: (r) => fmtCents(r.cost_cents, s) },
        { key: 'qty_on_hand', label: 'On hand', num: true, render: (r) => `<b>${r.qty_on_hand}</b>` },
        { key: 'qty_reserved', label: 'Resv', num: true },
        { key: 'reorder_level', label: 'Reorder', num: true },
      ], { empty: 'No products yet', panelId: 'stk-table' })}
      <div style="margin-top:16px">
        <div class="panel-hd">Recent stock movements</div>
        ${renderTable(movs.slice(0, 20), [
          { key: 'created_at', label: 'When', render: (r) => fmtDT(r.created_at) },
          { key: 'type', label: 'Type' },
          { key: 'product_id', label: 'Product ID' },
          { key: 'qty', label: 'Qty', num: true },
          { key: 'note', label: 'Note' },
        ], { empty: 'No movements' })}
      </div>`;

    $('#stk-add').onclick = () => productForm();
    $('#stk-adjust').onclick = () => adjustForm();
    $('#stk-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('#stk-table tbody tr').forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    };
  } catch (e) { container.innerHTML = `<div class="panel" style="padding:30px;color:var(--red)">${esc(e.message)}</div>`; }
}

async function productForm(prod) {
  if (!CATALOG.categories.length) await loadCatalog();
  const isEdit = !!prod;
  modal({
    title: isEdit ? `Edit — ${esc(prod.name)}` : 'New product',
    body: `
      <div class="fields-2">
        <div class="field"><label>SKU</label><input id="p-sku" value="${esc(prod?.sku || '')}"></div>
        <div class="field"><label>Barcode</label><input id="p-barcode" value="${esc(prod?.barcode || '')}"></div>
      </div>
      <div class="field"><label>Name</label><input id="p-name" value="${esc(prod?.name || '')}"></div>
      <div class="fields-3">
        <div class="field"><label>Price</label><input id="p-price" type="number" step="0.01" value="${prod ? (prod.price_cents / 100) : ''}"></div>
        <div class="field"><label>Cost</label><input id="p-cost" type="number" step="0.01" value="${prod ? (prod.cost_cents / 100) : ''}"></div>
        <div class="field"><label>Reorder level</label><input id="p-reorder" type="number" value="${prod?.reorder_level || 0}"></div>
      </div>
      <div class="fields-3">
        <div class="field"><label>Category</label><div style="display:flex;gap:8px;align-items:center"><select id="p-cat" class="cat-select"><option value="">— None —</option>${CATALOG.categories.map(c => `<option value="${c.id}"${prod?.category_id == c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__add_new__" class="font-semibold">+ Add New Category...</option></select><button class="btn btn-ghost btn-sm" id="p-cat-add">+ Add</button></div></div>
        <div class="field"><label>Unit</label><input id="p-unit" value="${esc(prod?.unit || 'each')}"></div>
        <div class="field"><label>Tax class</label><select id="p-tax">
          ${(await get('/tax-classes')).map(t => `<option value="${t.id}" ${(!prod || prod.tax_class_id == t.id) ? 'selected' : ''}>${esc(t.name)} (${(t.rate_bps / 100).toFixed(2)}%)</option>`).join('')}
        </select></div>
      </div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button>
             <button class="btn btn-primary" id="p-save">${isEdit ? 'Save changes' : 'Create product'}</button>`,
    onMount: (bd) => {
      $('#p-save').onclick = async () => {
        const body = {
          sku: $('#p-sku').value.trim(), name: $('#p-name').value.trim(),
          barcode: $('#p-barcode').value.trim() || null, unit: $('#p-unit').value.trim() || 'each',
          categoryId: $('#p-cat').value ? Number($('#p-cat').value) : null,
          priceCents: toCents($('#p-price').value), costCents: toCents($('#p-cost').value),
          reorderLevel: Math.round(Number($('#p-reorder').value) || 0), taxClassId: Number($('#p-tax').value),
        };
        try {
          if (isEdit) await put(`/products/${prod.id}`, body);
          else { const r = await post('/products', body); await api('GET', `/inventory/stock`); }
          await loadCatalog();
          toast('Product saved', 'ok'); closeModal(); navigate('stock');
        } catch (e) { toast(e.message, 'err'); }
      };

      // inline add category button — open the customizable category modal
      $('#p-cat-add').onclick = async () => openCategoryModal({ autoSelect: true, placeholder: 'e.g. Beverages' });

      // also allow selecting the special "__add_new__" option in the select to open the modal
      $('#p-cat').onchange = (e) => {
        if (e.target.value === '__add_new__') {
          e.target.value = '';
          openCategoryModal({ autoSelect: true, placeholder: 'e.g. Beverages' });
        }
      };
    },
  });
}

async function adjustForm() {
  if (!CATALOG.products.length) await loadCatalog();
  modal({
    title: 'Adjust stock',
    body: `
      <div class="field"><label>Product</label><select id="a-product">
        ${CATALOG.products.map(p => `<option value="${p.id}">${esc(p.sku)} — ${esc(p.name)} (on hand: ${p.qty_on_hand - p.qty_reserved})</option>`).join('')}</select></div>
      <div class="fields-2">
        <div class="field"><label>Qty (use + or −)</label><input id="a-qty" type="number" value="0"></div>
        <div class="field"><label>Type</label><select id="a-type"><option>ADJUST</option><option>RECEIPT</option><option>PO</option></select></div>
      </div>
      <div class="field"><label>Note</label><input id="a-note"></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" id="a-go">Adjust</button>`,
    onMount: (bd) => {
      $('#a-go').onclick = async () => {
        const qty = Math.round(Number($('#a-qty').value));
        if (!qty) return toast('Enter a non-zero qty', 'warn');
        try {
          await post('/inventory/adjust', { productId: Number($('#a-product').value), qty, type: $('#a-type').value, note: $('#a-note').value });
          await loadCatalog(); toast('Stock adjusted', 'ok'); closeModal(); navigate('stock');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// INVOICES (AR)
// ============================================================
async function invoiceView(container) {
  try {
    const [ar, ap, custs] = await Promise.all([get('/ar'), get('/ap'), get('/customers')]);
    const s = SETTINGS.currency;
    container.innerHTML = `
      <div class="page-header">
        <div><h2>Invoicing & Accounts</h2><div class="subtitle">Accounts receivable + payable</div></div>
        <div class="toolbar">
          <button class="btn btn-primary" id="inv-new">+ New invoice</button>
          <button class="btn" id="inv-credit">Issue credit note</button>
          <button class="btn" id="inv-receive">Receive payment</button>
        </div>
      </div>
      <div class="stat-cards">
        <div class="stat-card"><div class="k">Receivables (AR)</div><div class="v">${fmtCents(ar.reduce((s2, x) => s2 + (x.total_cents - x.paid_cents), 0), s)}</div></div>
        <div class="stat-card"><div class="k">Payables (AP)</div><div class="v">${fmtCents(ap.reduce((s2, x) => s2 + (x.total_cents - x.paid_cents), 0), s)}</div></div>
        <div class="stat-card"><div class="k">Open AR invoices</div><div class="v">${ar.filter(x => x.status !== 'PAID').length}</div></div>
      </div>
      <div class="fields-2" style="grid-template-columns:1fr 1fr; gap:0 14px;">
        ${renderTable(ar.slice(0, 30), [
          { key: 'doc_no', label: 'No.' }, { key: 'kind', label: 'Type' }, { key: 'customer_name', label: 'Customer' },
          { key: 'date', label: 'Date' }, { key: 'due_date', label: 'Due' },
          { key: 'total_cents', label: 'Total', num: true, render: (r) => fmtCents(r.total_cents, s) },
          { key: 'paid_cents', label: 'Paid', num: true },
          { key: 'status', label: 'Status', render: badgeFor },
        ], { empty: 'No AR invoices', panelId: 'inv-ar' })}
        ${renderTable(ap.slice(0, 15), [
          { key: 'doc_no', label: 'No.' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'date', label: 'Date' }, { key: 'due_date', label: 'Due' },
          { key: 'total_cents', label: 'Total', num: true, render: (r) => fmtCents(r.total_cents, s) },
          { key: 'status', label: 'Status', render: badgeFor },
        ], { empty: 'No AP bills', panelId: 'inv-ap' })}
      </div>`;

    $('#inv-new').onclick = () => arForm(custs);
    $('#inv-credit').onclick = () => creditNoteForm(custs);
    $('#inv-receive').onclick = () => receiveForm();
  } catch (e) { container.innerHTML = `<div class="panel" style="padding:30px;color:var(--red)">${esc(e.message)}</div>`; }
}

async function arForm(custs) {
  modal({
    title: 'Create invoice',
    body: `
      <div class="field"><label>Customer</label><select id="ar-cust">${custs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Subtotal (excl. tax)</label><input id="ar-amt" type="number" step="0.01" value="0"></div>
      <div class="fields-2">
        <div class="field"><label>${esc(SETTINGS.taxName)} %</label><input id="ar-tax" type="number" value="15" step="0.01"></div>
        <div class="field"><label>Payment due in (days)</label><input id="ar-days" type="number" value="${SETTINGS.termsDays}"></div>
      </div>
      <div class="field"><label>Note</label><input id="ar-note"></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="ar-save">Create</button>`,
    onMount: (bd) => {
      $('#ar-save').onclick = async () => {
        const subtotal = toCents($('#ar-amt').value);
        const tax = Math.round(subtotal * (Number($('#ar-tax').value) || 0) / 100);
        if (!subtotal) return toast('Enter an amount', 'warn');
        try {
          await post('/ar', { customerId: +$('#ar-cust').value, subtotalCents: subtotal, taxCents: tax, dueDays: +$('#ar-days').value, note: $('#ar-note').value });
          toast('Invoice created', 'ok'); closeModal(); navigate('invoices');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function creditNoteForm(custs) {
  modal({
    title: 'Issue credit note',
    body: `
      <div class="field"><label>Customer</label><select id="cn-cust">${custs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Amount (excl. tax)</label><input id="cn-amt" type="number" step="0.01" value="0"></div>
      <div class="field"><label>${esc(SETTINGS.taxName)} %</label><input id="cn-tax" type="number" value="15" step="0.01"></div>
      <div class="field"><label>Reason</label><input id="cn-note"></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="cn-save">Issue credit note</button>`,
    onMount: (bd) => {
      $('#cn-save').onclick = async () => {
        const subtotal = toCents($('#cn-amt').value);
        const tax = Math.round(subtotal * (Number($('#cn-tax').value) || 0) / 100);
        if (!subtotal) return toast('Enter an amount', 'warn');
        try {
          await post('/ar/credit-note', { customerId: +$('#cn-cust').value, subtotalCents: subtotal, taxCents: tax, note: $('#cn-note').value });
          toast('Credit note issued', 'ok'); closeModal(); navigate('invoices');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function receiveForm() {
  if (!CATALOG.customers.length) await loadCatalog();
  const open = await get('/ar?status=OPEN');
  const partial = await get('/ar?status=PARTIAL');
  const all = [...open, ...partial];
  modal({
    title: 'Receive customer payment',
    body: `
      <div class="field"><label>Customer</label><select id="rc-cust">${CATALOG.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Invoices to allocate (leave empty to auto-allocate)</label>
        <select id="rc-inv" multiple size="5">
          ${all.filter(i => i.kind === 'INVOICE').map(i => `<option value="${i.id}">${esc(i.doc_no)} — ${esc(i.customer_name)} — ${fmtCents(i.total_cents - i.paid_cents, SETTINGS.currency)}</option>`).join('')}
        </select></div>
      <div class="fields-2">
        <div class="field"><label>Amount</label><input id="rc-amt" type="number" step="0.01" value="0"></div>
        <div class="field"><label>Method</label><select id="rc-method"><option>CASH</option><option>CARD</option><option>MOBILE</option><option>BANK</option></select></div>
      </div>
      <div class="field"><label>Reference</label><input id="rc-ref"></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="rc-save">Receive</button>`,
    onMount: (bd) => {
      $('#rc-save').onclick = async () => {
        const sel = [...$('#rc-inv').selectedOptions].map(o => ({ invoiceId: +o.value, amountCents: 0 }));
        const amount = toCents($('#rc-amt').value);
        // auto-split to selected or leave empty for auto
        const allocs = sel.length ? sel.map(o => {
          const inv = all.find(i => i.id === o.invoiceId);
          return { invoiceId: inv.id, amountCents: Math.min(inv.total_cents - inv.paid_cents, amount / sel.length) };
        }) : [];
        try {
          await post('/payments/receive', {
            customerId: +$('#rc-cust').value, amount, allocations: allocs.some(a => a.amountCents <= 0) ? [] : allocs,
            method: $('#rc-method').value, reference: $('#rc-ref').value,
          });
          toast('Payment received', 'ok'); closeModal(); navigate('invoices');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// CUSTOMERS
// ============================================================
async function customersView(container) {
  try {
    const custs = await get('/customers');
    const s = SETTINGS.currency;
    container.innerHTML = `
      <div class="page-header"><div><h2>Customers</h2><div class="subtitle">${custs.length} records</div></div>
        <div class="toolbar"><input class="search-input" id="cust-search" placeholder="Search name / code / phone…">
        <button class="btn btn-primary" id="cust-add">+ New customer</button></div></div>
      ${renderTable(custs, [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Name', render: (r) => `<b>${esc(r.name)}</b>` },
        { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
        { key: 'credit_limit_cents', label: 'Credit limit', num: true, render: (r) => fmtCents(r.credit_limit_cents, s) },
        { key: 'outstanding_cents', label: 'Outstanding', num: true, render: (r) => `<span style="color:${r.outstanding_cents > 0 ? 'var(--red)' : 'var(--ink-3)'}">${fmtCents(r.outstanding_cents, s)}</span>` },
        { key: 'points', label: 'Points', num: true },
      ], { empty: 'No customers yet', panelId: 'cust-table', rowId: (r) => r.id })}
      <div style="margin-top:10px" id="cust-ledger"></div>`;

    $('#cust-add').onclick = () => customerForm();
    $('#cust-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('#cust-table tbody tr').forEach(tr => tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none');
    };
    $$('#cust-table tbody tr').forEach(tr => tr.onclick = async () => {
      const id = tr.dataset.id;
      const [ledger] = await Promise.all([get(`/customers/${id}/ledger`)]);
      const l = $('#cust-ledger');
      l.innerHTML = `
        <div class="panel">
          <div class="panel-hd">Ledger — ${esc(ledger.customer.name)} · outstanding ${fmtCents(ledger.outstanding, s)}</div>
          <div class="grid-wrap" style="max-height:300px">
          <table class="grid">
            <thead><tr><th>Ref</th><th>Date</th><th>Kind</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead>
            <tbody>
              ${ledger.invoices.map(i => `<tr><td>${esc(i.ref)}</td><td>${fmtDate(i.date)}</td><td>${esc(i.kind)}</td><td class="num">${fmtCents(i.amount, s)}</td><td class="num">${fmtCents(i.paid_cents, s)}</td><td class="num">${fmtCents(i.balance, s)}</td><td>${badgeFor(i.status)}</td></tr>`).join('')}
              ${ledger.payments.map(p => `<tr><td>${esc(p.ref)}</td><td>${fmtDate(p.date)}</td><td>Payment (${esc(p.method)})</td><td class="num" style="color:var(--green)">${fmtCents(-p.amount, s)}</td><td></td><td></td><td></td></tr>`).join('')}
              ${(!ledger.invoices.length && !ledger.payments.length) ? '<tr><td colspan="7" class="muted">No activity</td></tr>' : ''}
            </tbody>
          </table></div></div>`;
    });
  } catch (e) { container.innerHTML = `<div class="panel" style="padding:30px;color:var(--red)">${esc(e.message)}</div>`; }
}

async function customerForm(cust) {
  modal({
    title: cust ? 'Edit customer' : 'New customer',
    body: `
      <div class="fields-2">
        <div class="field"><label>Name</label><input id="c-name" value="${esc(cust?.name || '')}"></div>
        <div class="field"><label>Phone</label><input id="c-phone" value="${esc(cust?.phone || '')}"></div>
      </div>
      <div class="field"><label>Email</label><input id="c-email" value="${esc(cust?.email || '')}"></div>
      <div class="field"><label>Address</label><input id="c-addr" value="${esc(cust?.address || '')}"></div>
      <div class="field"><label>Credit limit (${SETTINGS.currency})</label><input id="c-limit" type="number" step="0.01" value="${cust ? (cust.credit_limit_cents / 100) : 0}"></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="c-save">Save</button>`,
    onMount: (bd) => {
      $('#c-save').onclick = async () => {
        const body = { name: $('#c-name').value.trim(), phone: $('#c-phone').value.trim(), email: $('#c-email').value.trim(), address: $('#c-addr').value.trim(), creditLimitCents: toCents($('#c-limit').value) };
        if (!body.name) return toast('Name required', 'warn');
        try {
          if (cust) await put(`/customers/${cust.id}`, body); else await post('/customers', body);
          await loadCatalog(); toast('Customer saved', 'ok'); closeModal(); navigate('customers');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// SUPPLIERS
// ============================================================
async function suppliersView(container) {
  try {
    const supps = await get('/suppliers');
    const s = SETTINGS.currency;
    container.innerHTML = `
      <div class="page-header"><div><h2>Suppliers</h2><div class="subtitle">${supps.length} records</div></div>
        <div class="toolbar"><button class="btn btn-primary" id="sup-add">+ New supplier</button></div></div>
      ${renderTable(supps, [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Name', render: (r) => `<b>${esc(r.name)}</b>` },
        { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'tax_id', label: 'Tax ID' },
        { key: 'owing_cents', label: 'We owe', num: true, render: (r) => `<span style="color:${r.owing_cents > 0 ? 'var(--amber)' : 'var(--ink-3)'}">${fmtCents(r.owing_cents, s)}</span>` },
      ], { empty: 'No suppliers yet', panelId: 'sup-table', rowId: (r) => r.id })}
      <div style="margin-top:10px" id="sup-ledger"></div>`;

    $('#sup-add').onclick = () => supplierForm();
    $$('#sup-table tbody tr').forEach(tr => tr.onclick = async () => {
      const [ledger] = await Promise.all([get(`/suppliers/${tr.dataset.id}/ledger`)]);
      $('#sup-ledger').innerHTML = `
        <div class="panel"><div class="panel-hd">Ledger — ${esc(ledger.supplier.name)} · we owe ${fmtCents(ledger.owing, s)}</div>
        <div class="grid-wrap" style="max-height:300px">
        <table class="grid"><thead><tr><th>Ref</th><th>Date</th><th class="num">Bill</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead><tbody>
        ${ledger.bills.map(b => `<tr><td>${esc(b.ref)}</td><td>${fmtDate(b.date)}</td><td class="num">${fmtCents(b.amount, s)}</td><td class="num">${fmtCents(b.paid_cents, s)}</td><td class="num">${fmtCents(b.balance, s)}</td><td>${badgeFor(b.status)}</td></tr>`).join('')}
        ${ledger.payments.map(p => `<tr><td>${esc(p.ref)}</td><td>${fmtDate(p.date)}</td><td class="num" style="color:var(--green)">${fmtCents(-p.amount, s)}</td><td></td><td></td><td>Payment</td></tr>`).join('')}
        ${(!ledger.bills.length && !ledger.payments.length) ? '<tr><td colspan="6" class="muted">No activity</td></tr>' : ''}
        </tbody></table></div></div>`;
    });
  } catch (e) { container.innerHTML = `<div class="panel" style="padding:30px;color:var(--red)">${esc(e.message)}</div>`; }
}

async function supplierForm(sup) {
  modal({
    title: sup ? 'Edit supplier' : 'New supplier',
    body: `
      <div class="fields-2">
        <div class="field"><label>Name</label><input id="s-name" value="${esc(sup?.name || '')}"></div>
        <div class="field"><label>Phone</label><input id="s-phone" value="${esc(sup?.phone || '')}"></div>
      </div>
      <div class="field"><label>Email</label><input id="s-email" value="${esc(sup?.email || '')}"></div>
      <div class="fields-2">
        <div class="field"><label>Address</label><input id="s-addr" value="${esc(sup?.address || '')}"></div>
        <div class="field"><label>Tax ID</label><input id="s-tax" value="${esc(sup?.tax_id || '')}"></div>
      </div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="s-save">Save</button>`,
    onMount: (bd) => {
      $('#s-save').onclick = async () => {
        const body = { name: $('#s-name').value.trim(), phone: $('#s-phone').value.trim(), email: $('#s-email').value.trim(), address: $('#s-addr').value.trim(), taxId: $('#s-tax').value.trim() };
        if (!body.name) return toast('Name required', 'warn');
        try {
          if (sup) await put(`/suppliers/${sup.id}`, body); else await post('/suppliers', body);
          toast('Supplier saved', 'ok'); closeModal(); navigate('suppliers');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// PURCHASING
// ============================================================
async function purchasingView(container) {
  try {
    const [pos, supps] = await Promise.all([get('/purchase-orders'), get('/suppliers')]);
    const s = SETTINGS.currency;
    container.innerHTML = `
      <div class="page-header"><div><h2>Purchasing</h2><div class="subtitle">Purchase orders & goods receipts</div></div>
        <div class="toolbar">
          <button class="btn btn-primary" id="po-new">+ New purchase order</button>
          <button class="btn" id="po-receive">Receive goods</button>
          <button class="btn" id="po-supplier-pay">Pay supplier</button>
        </div></div>
      <div class="stat-cards">
        <div class="stat-card"><div class="k">Orders placed</div><div class="v">${pos.filter(p => p.status !== 'DRAFT').length}</div></div>
        <div class="stat-card"><div class="k">Drafts</div><div class="v">${pos.filter(p => p.status === 'DRAFT').length}</div></div>
        <div class="stat-card"><div class="k">Awaiting receipt</div><div class="v">${pos.filter(p => p.status === 'ORDERED').length}</div></div>
      </div>
      ${renderTable(pos, [
        { key: 'doc_no', label: 'PO No.', render: (r) => `<b>${esc(r.doc_no)}</b>` },
        { key: 'supplier_name', label: 'Supplier' },
        { key: 'created_at', label: 'Created', render: (r) => fmtDT(r.created_at) },
        { key: 'total_cents', label: 'Total', num: true, render: (r) => fmtCents(r.total_cents, s) },
        { key: 'status', label: 'Status', render: badgeFor },
        { key: '', label: '', render: (r) => `<button class="btn btn-sm" data-po-view="${r.id}">View</button>` },
      ], { empty: 'No purchase orders', panelId: 'po-table' })}`;

    $('#po-new').onclick = () => poForm(supps);
    $('#po-receive').onclick = () => receiveForm(supps);
    $('#po-supplier-pay').onclick = () => paySupplierForm(supps);
    $$('[data-po-view]').forEach(b => b.onclick = () => viewPo(+b.dataset.poView));
  } catch (e) { container.innerHTML = `<div class="panel" style="padding:30px;color:var(--red)">${esc(e.message)}</div>`; }
}

async function poForm(supps) {
  if (!CATALOG.products.length) await loadCatalog();
  let rows = [{ productId: '', qty: 1, cost: '' }];
  const renderRows = () => rows.map((r, i) => `
    <div class="fields-4" data-row="${i}">
      <div class="field"><label>Product</label><select data-k="productId">
        ${CATALOG.products.map(p => `<option value="${p.id}" ${r.productId == p.id ? 'selected' : ''}>${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Qty</label><input data-k="qty" type="number" value="${r.qty}" min="1"></div>
      <div class="field"><label>Unit cost</label><input data-k="cost" type="number" value="${r.cost}" step="0.01"></div>
      <div class="field" style="justify-content:flex-end; align-items:center"><button class="btn btn-sm" data-rm="${i}">Remove</button></div>
    </div>`).join('');
  modal({
    title: 'New purchase order', wide: true,
    body: `
      <div class="field"><label>Supplier</label><select id="po-sup">${supps.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Expected date</label><input id="po-date" type="date"></div>
      <div class="field"><label>Items</label><div id="po-rows">${renderRows()}</div></div>
      <button class="btn btn-sm" id="po-addrow">+ Add line</button>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button>
             <button class="btn btn-success" id="po-order">Place order</button>`,
    onMount: (bd) => {
      $('#po-addrow').onclick = () => { rows.push({ productId: '', qty: 1, cost: '' }); $('#po-rows').innerHTML = renderRows(); wireRows(); };
      wireRows();
      function wireRows() {
        $$('#po-rows [data-k]').forEach(inp => inp.addEventListener('input', (e) => {
          const i = +inp.closest('[data-row]').dataset.row;
          rows[i][inp.dataset.k] = inp.dataset.k === 'qty' ? +inp.value : (inp.dataset.k === 'cost' ? inp.value : +inp.value);
        }));
        $$('#po-rows [data-rm]').forEach(b => b.onclick = () => { rows.splice(+b.dataset.rm, 1); $('#po-rows').innerHTML = renderRows(); wireRows(); });
      }
      $('#po-order').onclick = async () => {
        const items = rows.filter(r => r.productId).map(r => ({ productId: +r.productId, qty: +r.qty || 1, unitCostCents: toCents(r.cost) }));
        if (!items.length) return toast('Add at least one line', 'warn');
        try {
          await post('/purchase-orders', { supplierId: +$('#po-sup').value, items, expectedDate: $('#po-date').value || null });
          toast('Purchase order created', 'ok'); closeModal(); navigate('purchasing');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function receiveForm(supps) {
  const ordered = await get('/purchase-orders?status=ORDERED');
  if (!ordered.length) return toast('No ordered POs awaiting receipt', 'warn');
  let selected = ordered[0].id;
  let qties = {};
  const renderLines = () => {
    const po = ordered.find(p => p.id == selected);
    return (po?.lines || []).map(l => {
      const left = l.qty - l.qty_received;
      return `<div class="fields-4" style="margin-bottom:6px">
        <div class="field"><label>Product</label><div>${esc(l.product_name)}</div></div>
        <div class="field"><label>Ordered</label><div>${l.qty} (received ${l.qty_received})</div></div>
        <div class="field"><label>Receive qty</label><input data-p="${l.product_id}" type="number" value="${qties[l.product_id] ?? left}" min="0" max="${left}"></div>
        <div class="field"><label>Unit cost</label><div>${fmtCents(l.unit_cost_cents, SETTINGS.currency)}</div></div>
      </div>`;
    }).join('');
  };
  modal({
    title: 'Receive goods against PO', wide: true,
    body: `
      <div class="field"><label>Purchase order</label><select id="gr-po">${ordered.map(p => `<option value="${p.id}">${esc(p.doc_no)} — ${esc(p.supplier_name)}</option>`).join('')}</select></div>
      <div id="gr-lines">${renderLines()}</div>
      <div class="field"><label>Note</label><input id="gr-note"></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="gr-save">Receive & create bill</button>`,
    onMount: (bd) => {
      $('#gr-po').onchange = (e) => { selected = +e.target.value; qties = {}; $('#gr-lines').innerHTML = renderLines(); wire(); };
      wire();
      function wire() { $$('#gr-lines [data-p]').forEach(i => i.oninput = () => qties[i.dataset.p] = Math.min(+i.value || 0, +i.max || 0)); }
      $('#gr-save').onclick = async () => {
        const items = Object.entries(qties).filter(([, q]) => q > 0).map(([pid, q]) => ({ productId: +pid, qty: q }));
        if (!items.length) return toast('Enter at least one line', 'warn');
        try {
          const r = await post(`/purchase-orders/${selected}/receive`, { items, note: $('#gr-note').value });
          toast(`Received ${esc(r.grNo)} · bill ${r.bill.doc_no}`, 'ok');
          await loadCatalog(); closeModal(); navigate('purchasing');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function paySupplierForm(supps) {
  modal({
    title: 'Pay supplier',
    body: `
      <div class="field"><label>Supplier</label><select id="ps-sup">${supps.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="fields-2">
        <div class="field"><label>Amount</label><input id="ps-amt" type="number" step="0.01"></div>
        <div class="field"><label>Method</label><select id="ps-method"><option>CASH</option><option>BANK</option><option>MOBILE</option><option>CARD</option></select></div>
      </div>
      <div class="field"><label>Reference</label><input id="ps-ref"></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="ps-save">Pay</button>`,
    onMount: (bd) => {
      $('#ps-save').onclick = async () => {
        const amount = toCents($('#ps-amt').value);
        if (!amount) return toast('Enter amount', 'warn');
        try {
          await post('/payments/pay-supplier', { supplierId: +$('#ps-sup').value, amount, method: $('#ps-method').value, reference: $('#ps-ref').value });
          toast('Payment made', 'ok'); closeModal(); navigate('suppliers');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function viewPo(id) {
  const po = await get(`/purchase-orders/${id}`);
  const s = SETTINGS.currency;
  modal({
    title: `${po.doc_no} — ${esc(po.supplier_name)}`,
    body: `
      <div style="display:flex; gap:20px; margin-bottom:10px">
        <span>Status: ${badgeFor(po.status)}</span><span>Expected: ${fmtDate(po.expected_date)}</span></div>
      ${renderTable(po.lines, [
        { key: 'product_name', label: 'Product' }, { key: 'qty', label: 'Qty', num: true },
        { key: 'qty_received', label: 'Received', num: true },
        { key: 'unit_cost_cents', label: 'Unit cost', num: true, render: (r) => fmtCents(r.unit_cost_cents, s) },
        { key: 'line_total_cents', label: 'Line total', num: true, render: (r) => fmtCents(r.line_total_cents, s) },
      ], { empty: 'No lines' })}
      ${po.status === 'DRAFT' ? '<p style="margin-top:10px" class="muted">Place this order before receiving goods.</p>' : ''}`,
    footer: `<button class="btn" onclick="closeModal()">Close</button>
      ${po.status === 'DRAFT' ? '<button class="btn btn-primary" id="po-place">Place order</button>' : ''}`,
    onMount: (bd) => {
      const b = $('#po-place'); if (b) b.onclick = async () => {
        try { await post(`/purchase-orders/${id}/place`, {}); toast('PO placed', 'ok'); closeModal(); navigate('purchasing'); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// ACCOUNTING
// ============================================================
async function accountingView(container) {
  try {
    const [chart, pl, bs, verify, entries, tb] = await Promise.all([
      get('/accounting/chart'), get('/accounting/pl'), get('/accounting/balance-sheet'),
      get('/accounting/verify'), get('/accounting/entries?limit=25'), get('/accounting/trial-balance'),
    ]);
    const s = SETTINGS.currency;
    const money = (c) => fmtCents(c, s);
    container.innerHTML = `
      <div class="page-header"><div><h2>Accounting</h2><div class="subtitle">${verify.balanced ? 'Journal is balanced' : 'Journal NOT balanced'}</div></div>
        <div class="toolbar"><button class="btn btn-primary" id="acc-journal">Manual journal entry</button></div></div>
      <div class="stat-cards">
        <div class="stat-card"><div class="k">Revenue</div><div class="v">${money(pl.revenue)}</div></div>
        <div class="stat-card"><div class="k">Expenses</div><div class="v">${money(pl.expenses)}</div></div>
        <div class="stat-card"><div class="k" style="color:${pl.netProfit < 0 ? 'var(--red)' : 'var(--green)'}">Net profit</div><div class="v" style="color:${pl.netProfit < 0 ? 'var(--red)' : 'var(--green)'}">${money(pl.netProfit)}</div></div>
        <div class="stat-card"><div class="k">Total assets</div><div class="v">${money(bs.totalAssets)}</div></div>
        <div class="stat-card"><div class="k">Debits = Credits</div><div class="v" style="font-size:15px">${fmtCents(verify.debits, '')} = ${fmtCents(verify.credits, '')}</div></div>
      </div>
      <div class="fields-2" style="grid-template-columns: 2fr 1fr; gap: 12px;">
        ${renderTable(chart, [
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'type', label: 'Type', render: (r) => `<span class="badge badge-blue">${esc(r.type)}</span>` },
        ], { empty: 'No accounts', panelId: 'acc-chart', caption: 'Chart of Accounts' })}
        ${renderTable(tb.filter(x => x.debits || x.credits), [
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' },
          { key: 'debits', label: 'Debit', num: true, render: (r) => fmtCents(r.debits, '') },
          { key: 'credits', label: 'Credit', num: true, render: (r) => fmtCents(r.credits, '') },
        ], { empty: 'Empty trial balance', panelId: 'acc-tb', caption: 'Trial Balance' })}
      </div>
      <div style="margin-top:14px">
        ${renderTable(entries, [
          { key: 'doc_no', label: 'No.' }, { key: 'date', label: 'Date' },
          { key: 'reference', label: 'Reference' }, { key: 'description', label: 'Description' },
          { key: 'debits', label: 'Debit', num: true, render: (r) => fmtCents(r.debits, '') },
          { key: 'credits', label: 'Credit', num: true, render: (r) => fmtCents(r.credits, '') },
        ], { empty: 'No journal entries', panelId: 'acc-entries', caption: 'General Journal' })}
      </div>`;

    $('#acc-journal').onclick = () => journalForm(chart);
  } catch (e) { container.innerHTML = `<div class="panel" style="padding:30px;color:var(--red)">${esc(e.message)}</div>`; }
}

async function journalForm(chart) {
  let lines = [{ code: '', debit: '', credit: '' }];
  const renderLines = () => lines.map((l, i) => `
    <div class="fields-4" data-row="${i}" style="margin-bottom:6px">
      <div class="field"><label>Account</label><select data-k="code">
        <option value="">— select —</option>
        ${chart.map(a => `<option value="${a.code}" ${l.code === a.code ? 'selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Debit</label><input data-k="debit" type="number" step="0.01" value="${l.debit}"></div>
      <div class="field"><label>Credit</label><input data-k="credit" type="number" step="0.01" value="${l.credit}"></div>
      <div class="field" style="justify-content:flex-end; align-items:center"><button class="btn btn-sm" data-rm="${i}">Remove</button></div>
    </div>`).join('');
  modal({
    title: 'Manual journal entry', wide: true,
    body: `
      <div class="fields-3">
        <div class="field"><label>Date</label><input id="j-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Description</label><input id="j-desc"></div>
        <div class="field"><label>Reference</label><input id="j-ref"></div>
      </div>
      <div class="field"><label>Lines (must balance)</label><div id="j-lines">${renderLines()}</div></div>
      <button class="btn btn-sm" id="j-addrow">+ Add line</button>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="j-post">Post entry</button>`,
    onMount: (bd) => {
      const wire = () => {
        $$('#j-lines [data-k]').forEach(i => i.addEventListener('input', (e) => {
          const r = +i.closest('[data-row]').dataset.row;
          lines[r][i.dataset.k] = i.dataset.k === 'code' ? i.value : i.value;
        }));
        $$('#j-lines [data-rm]').forEach(b => b.onclick = () => { lines.splice(+b.dataset.rm, 1); $('#j-lines').innerHTML = renderLines(); wire(); });
      };
      $('#j-addrow').onclick = () => { lines.push({ code: '', debit: '', credit: '' }); $('#j-lines').innerHTML = renderLines(); wire(); };
      wire();
      $('#j-post').onclick = async () => {
        const payload = lines.filter(l => l.code).map(l => ({ code: l.code, debit: toCents(l.debit), credit: toCents(l.credit) }));
        if (!payload.length) return toast('Add lines', 'warn');
        try {
          await post('/accounting/journal', { date: $('#j-date').value, description: $('#j-desc').value, reference: $('#j-ref').value, lines: payload });
          toast('Entry posted', 'ok'); closeModal(); navigate('accounting');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// REPORTS
// ============================================================
async function reportsView(container) {
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const load = async (f, t) => {
    const [summary, byDay, top, cats, cashiers, dead] = await Promise.all([
      get(`/reports/summary?from=${f}&to=${t}`), get(`/reports/by-day?from=${f}&to=${t}`),
      get(`/reports/top-products?limit=10&from=${f}&to=${t}`), get(`/reports/by-category?from=${f}&to=${t}`),
      get(`/reports/cashiers?from=${f}&to=${t}`), get(`/reports/dead-stock?days=30`),
    ]);
    const s = SETTINGS.currency;
    container.innerHTML = `
      <div class="page-header"><div><h2>Reports</h2><div class="subtitle">${f} → ${t}</div></div>
        <div class="toolbar">
          <input id="r-from" type="date" value="${f}"> <span class="muted">to</span>
          <input id="r-to" type="date" value="${t}">
          <button class="btn" id="r-run">Refresh</button>
        </div></div>
      <div class="stat-cards">
        <div class="stat-card"><div class="k">Sales</div><div class="v">${fmtCents(summary.netSales, s)}</div><div class="d">${summary.saleCount} transactions</div></div>
        <div class="stat-card"><div class="k">Gross (before refunds)</div><div class="v">${fmtCents(summary.grossSales, s)}</div></div>
        <div class="stat-card"><div class="k">Refunds</div><div class="v" style="color:var(--red)">${fmtCents(summary.refundTotal, s)}</div></div>
        <div class="stat-card"><div class="k">Dead stock (>30d)</div><div class="v" style="color:${dead.length ? 'var(--amber)' : 'var(--green)'}">${dead.length}</div></div>
      </div>
      <div class="grid-2-zone">
        <div>${renderTable(byDay, [
          { key: 'day', label: 'Date', render: (r) => fmtDate(r.day) }, { key: 'count', label: 'Sales', num: true },
          { key: 'sales', label: 'Sales amount', num: true, render: (r) => fmtCents(r.sales, s) },
          { key: 'refunds', label: 'Refunds', num: true, render: (r) => fmtCents(r.refunds, s) },
        ], { empty: 'No sales', panelId: 'r-byd' })}
        ${renderTable(top, [
          { key: 'product_name', label: 'Product' },
          { key: 'qty_sold', label: 'Qty sold', num: true }, { key: 'qty_refunded', label: 'Refunded', num: true },
          { key: 'revenue', label: 'Revenue', num: true, render: (r) => fmtCents(r.revenue, s) },
        ], { empty: 'No product data', panelId: 'r-top' })}
        ${renderTable(cashiers, [
          { key: 'username', label: 'Cashier' }, { key: 'sales', label: 'Sales count', num: true },
          { key: 'total', label: 'Total', num: true, render: (r) => fmtCents(r.total, s) },
        ], { empty: 'No data', panelId: 'r-cash' })}</div>
        <div>${renderTable(cats, [
          { key: 'category', label: 'Category' }, { key: 'qty', label: 'Qty', num: true },
          { key: 'revenue', label: 'Revenue', num: true, render: (r) => fmtCents(r.revenue, s) },
        ], { empty: 'No data', panelId: 'r-cats' })}
        ${renderTable(dead, [
          { key: 'name', label: 'Product' }, { key: 'qty_on_hand', label: 'On hand', num: true },
          { key: 'cost_cents', label: 'Cost', num: true, render: (r) => fmtCents(r.cost_cents, s) },
          { key: 'price_cents', label: 'Price', num: true, render: (r) => fmtCents(r.price_cents, s) },
        ], { empty: 'No dead stock', panelId: 'r-dead' })}</div>
      </div>`;
    $('#r-run').onclick = () => load($('#r-from').value, $('#r-to').value);
  };
  load(from, to);
}

// ============================================================
// END OF DAY
// ============================================================
async function eodView(container) {
  const [shifts, summary] = await Promise.all([get('/eod/shifts'), get('/reports/summary')]);
  const s = SETTINGS.currency;
  container.innerHTML = `
    <div class="page-header"><div><h2>Day Close</h2><div class="subtitle">Cash reconciliation & shift management</div></div></div>
    <div class="stat-cards">
      <div class="stat-card"><div class="k">Today's sales</div><div class="v">${fmtCents(summary.netSales, s)}</div></div>
      <div class="stat-card"><div class="k">Refunds</div><div class="v" style="color:var(--red)">${fmtCents(summary.refundTotal, s)}</div></div>
    </div>
    <div class="fields-2" style="grid-template-columns:1fr 1fr; gap:12px">
      <div class="panel"><div class="panel-hd">Open a shift</div><div class="modal-bd">
        <div class="fields-2">
          <div class="field"><label>Opening cash in drawer</label><input id="eod-opening" type="number" value="0" step="0.01"></div>
          <div class="field"><label>Location</label><select id="eod-loc"><option>Main Store</option></select></div>
        </div>
        <button class="btn btn-primary" id="eod-open" style="margin-top:12px">Open shift</button>
      </div></div>
      <div class="panel"><div class="panel-hd">Close a shift</div><div class="modal-bd">
        <table class="grid" id="eod-shifts">
          <thead><tr><th>Shift</th><th>Cashier</th><th>Open</th><th>Cash in drawer</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${shifts.map(sh => `<tr>
              <td>${esc(sh.doc_no)}</td><td>${esc(sh.full_name || sh.username || '')}</td><td>${fmtDT(sh.opened_at)}</td>
              <td class="num">${fmtCents(sh.opening_cash_cents, s)}</td><td>${sh.status === 'OPEN' ? '<span class="badge badge-green">Open</span>' : '<span class="badge badge-gray">Closed</span>'}</td>
              <td>${sh.status === 'OPEN' ? `<button class="btn btn-sm btn-primary" data-eod-cl="${sh.id}">Close</button>` : `<span class="muted">variance ${fmtCents(sh.variance_cents || 0, s)}</span>`}</td>
            </tr>`).join('')}
            ${!shifts.length ? '<tr><td colspan="6" class="muted">No shifts yet</td></tr>' : ''}
          </tbody>
        </table>
      </div></div>
    </div>`;
  $('#eod-open').onclick = async () => {
    try {
      await post('/eod/open', { openingCashCents: toCents($('#eod-opening').value) });
      toast('Shift opened', 'ok'); navigate('eod');
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-eod-cl]').forEach(b => b.onclick = () => {
    const id = +b.dataset.eodCl;
    modal({
      title: 'Close shift',
      body: `<div class="field"><label>Counted cash in drawer</label><input id="ec-count" type="number" step="0.01"></div>
             <div class="field"><label>Note</label><input id="ec-note"></div>`,
      footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="ec-save">Close shift</button>`,
      onMount: (bd) => {
        $('#ec-save').onclick = async () => {
          try {
            const r = await post('/eod/close', { shiftId: id, countedCashCents: toCents($('#ec-count').value), note: $('#ec-note').value });
            const v = r.variance_cents;
            toast(`Shift closed — variance ${fmtCents(v, SETTINGS.currency)}`, v === 0 ? 'ok' : 'warn');
            closeModal(); navigate('eod');
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  });
}

// ============================================================
// SETTINGS
// ============================================================
async function settingsView(container) {
  const [users, audit, printers] = await Promise.all([get('/users'), get('/audit?limit=50'), get('/printers')]);
  PRINTERS = printers;
  const fiscal = SETTINGS.fiscal ? 'checked' : '';
  const cashDr = SETTINGS.cashDrawer ? 'checked' : '';

  container.innerHTML = `
    <div class="page-header"><div><h2>Settings & Users</h2><div class="subtitle">Company, printing, tax & access control</div></div>
      <div class="toolbar"><button class="btn btn-primary" id="set-user-add">+ New user</button></div></div>
    <div class="grid-2-zone">
      <div>
        <div class="panel"><div class="panel-hd">Company</div><div class="modal-bd">
          <div class="fields-2">
            <div class="field"><label>Company name</label><input id="set-name" value="${esc(SETTINGS.company)}"></div>
            <div class="field"><label>Currency symbol</label><input id="set-cur" value="${esc(SETTINGS.currency)}"></div>
          </div>
          <div class="field"><label>Address</label><input id="set-addr" value="${esc(SETTINGS.address || '')}"></div>
          <div class="fields-2">
            <div class="field"><label>Phone</label><input id="set-phone" value="${esc(SETTINGS.phone || '')}"></div>
            <div class="field"><label>Tax ID (TIN)</label><input id="set-tin" value="${esc(SETTINGS.tin || '')}"></div>
          </div>
          <div class="fields-2">
            <div class="field"><label>Tax name</label><input id="set-tax" value="${esc(SETTINGS.taxName)}"></div>
            <div class="field"><label>Payment terms (days)</label><input id="set-days" value="${esc(SETTINGS.termsDays)}"></div>
          </div>
          <div class="fields-2" style="margin-top:8px">
            <label class="toggle-label"><input type="checkbox" id="set-fiscal" ${fiscal}> Enable Zimra fiscal receipts</label>
            <label class="toggle-label"><input type="checkbox" id="set-cashdrawer" ${cashDr}> Auto-open cash drawer</label>
          </div>
          <div style="margin-top:10px"><button class="btn btn-primary" id="set-save">Save settings</button></div>
        </div></div>

        <div class="panel" style="margin-top:12px"><div class="panel-hd">Printers</div><div class="modal-bd">
          <div id="printer-list">${renderPrinterList(printers)}</div>
          <div style="margin-top:10px"><button class="btn" id="set-printer-add">+ Add printer</button></div>
        </div></div>

        <div class="panel" style="margin-top:12px"><div class="panel-hd">Audit trail</div>
          ${renderTable(audit, [
            { key: 'created_at', label: 'When', render: (r) => fmtDT(r.created_at) },
            { key: 'username', label: 'User' }, { key: 'action', label: 'Action' }, { key: 'detail', label: 'Detail' },
          ], { empty: 'No activity', panelId: 'set-audit' })}
        </div>
      </div>
      <div class="panel"><div class="panel-hd">Users & roles</div>
        ${renderTable(users, [
          { key: 'username', label: 'Username', render: (r) => `<b>${esc(r.username)}</b>` },
          { key: 'full_name', label: 'Name' }, { key: 'role', label: 'Role', render: (r) => `<span class="badge badge-blue">${esc(r.role)}</span>` },
          { key: 'active', label: 'Active', render: (r) => r.active ? 'Yes' : 'No' },
        ], { empty: 'No users', panelId: 'set-users', rowId: (r) => r.id })}</div>
    </div>`;

  // save settings
  $('#set-save').onclick = async () => {
    const body = {
      company: $('#set-name').value.trim(), address: $('#set-addr').value.trim(),
      phone: $('#set-phone').value.trim(), tin: $('#set-tin').value.trim(),
      currency: $('#set-cur').value.trim(), taxName: $('#set-tax').value.trim(),
      termsDays: $('#set-days').value.trim(),
      fiscal: $('#set-fiscal').checked, cashDrawer: $('#set-cashdrawer').checked,
    };
    try { await post('/settings', body); await loadSettings(); toast('Settings saved', 'ok'); navigate('settings'); }
    catch (e) { toast(e.message, 'err'); }
  };

  // add printer
  $('#set-printer-add').onclick = () => printerForm();

  // click to edit printer
  $$('#printer-list .printer-card').forEach(card => {
    card.querySelector('.pr-edit')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = printers.find(x => x.id === Number(card.dataset.pid));
      if (p) printerForm(p);
    });
    card.querySelector('.pr-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(card.dataset.pid);
      if (confirm('Delete this printer?')) delPrinter(id);
    });
    card.querySelector('.pr-test')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = printers.find(x => x.id === Number(card.dataset.pid));
      if (p) testPrint(p);
    });
    card.querySelector('.pr-default')?.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = Number(card.dataset.pid);
      setDefaultPrinter(id, e.target.checked);
    });
  });

  $('#set-user-add').onclick = () => userForm();
  $$('#set-users tbody tr').forEach(tr => tr.onclick = () => {
    const u = users.find(x => x.id == tr.dataset.id);
    if (u) userForm(u);
  });
}

function renderPrinterList(printers) {
  if (!printers.length) return '<div class="muted" style="padding:8px">No printers configured</div>';
  return printers.map(p => `
    <div class="printer-card" data-pid="${p.id}" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;background:var(--bg)">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <div>
          <b>${esc(p.name)}</b>
          <span class="badge badge-blue" style="margin-left:4px">${esc(p.type)}</span>
          <span class="badge badge-gray">${esc(p.connection)}</span>
          ${p.ip_address ? `<span class="badge badge-gray">${esc(p.ip_address)}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <label class="toggle-label" style="font-size:11px"><input type="radio" name="pr-default" class="pr-default" ${p.is_default ? 'checked' : ''}> Default</label>
          ${p.cash_drawer ? '<span class="badge badge-green">Drawer</span>' : ''}
          ${p.fiscal ? '<span class="badge badge-amber">Fiscal</span>' : ''}
          <button class="btn btn-sm pr-test">Test</button>
          <button class="btn btn-sm pr-edit">Edit</button>
          <button class="btn btn-sm btn-danger pr-del">×</button>
        </div>
      </div>
    </div>`).join('');
}

function printerForm(p) {
  const types = ['80mm', '58mm', 'A4', 'Generic'];
  const conns = ['USB', 'Bluetooth', 'Network', 'Serial'];
  modal({
    title: p ? `Edit printer — ${esc(p.name)}` : 'Add printer',
    body: `
      <div class="field"><label>Name</label><input id="pr-name" value="${esc(p?.name || '')}"></div>
      <div class="fields-2">
        <div class="field"><label>Type</label><select id="pr-type">${types.map(t => `<option ${p?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>Connection</label><select id="pr-conn">${conns.map(c => `<option ${p?.connection === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      </div>
      <div class="field" id="pr-ip-wrap" style="${p?.connection === 'Network' ? '' : 'display:none'}"><label>IP Address</label><input id="pr-ip" value="${esc(p?.ip_address || '')}" placeholder="192.168.1.xx"></div>
      <div class="fields-2">
        <label class="toggle-label"><input type="checkbox" id="pr-drawer" ${p?.cash_drawer ? 'checked' : ''}> Cash drawer</label>
        <label class="toggle-label"><input type="checkbox" id="pr-fiscal" ${p?.fiscal ? 'checked' : ''}> Zimra fiscal device</label>
      </div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="pr-save">Save</button>`,
    onMount: () => {
      $('#pr-conn').onchange = () => { $('#pr-ip-wrap').style.display = $('#pr-conn').value === 'Network' ? '' : 'none'; };
      $('#pr-save').onclick = async () => {
        const body = {
          name: $('#pr-name').value.trim(), type: $('#pr-type').value,
          connection: $('#pr-conn').value, ipAddress: $('#pr-ip').value.trim() || null,
          cashDrawer: $('#pr-drawer').checked, fiscal: $('#pr-fiscal').checked,
        };
        if (!body.name) return toast('Name required', 'warn');
        try {
          if (p) await put(`/printers/${p.id}`, body); else await post('/printers', body);
          toast('Printer saved', 'ok'); closeModal(); navigate('settings');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function delPrinter(id) {
  try { await del(`/printers/${id}`); await loadSettings(); navigate('settings'); toast('Deleted', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}

async function setDefaultPrinter(id, checked) {
  if (!checked) return;
  try { await put(`/printers/${id}`, { isDefault: true }); await loadSettings(); toast('Default set', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}

function testPrint(printer) {
  const w = window.open('', '_blank', 'width=320,height=500');
  if (!w) return toast('Pop-up blocked — allow pop-ups for test print', 'warn');
  w.document.write(buildReceiptHTML(null, printer));
  w.document.close();
  setTimeout(() => { w.print(); w.close(); }, 400);
}

async function userForm(u) {
  modal({
    title: u ? `Edit user — ${esc(u.username)}` : 'New user',
    body: `
      ${u ? '' : `<div class="field"><label>Username</label><input id="u-user"></div>`}
      <div class="field"><label>Full name</label><input id="u-name" value="${esc(u?.full_name || '')}"></div>
      <div class="fields-2">
        <div class="field"><label>Role</label><select id="u-role">
          ${['owner', 'manager', 'accountant', 'cashier'].map(r => `<option ${u?.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select></div>
        <div class="field"><label>${u ? 'New password (blank = keep)' : 'Password'}</label><input id="u-pw" type="password"></div>
      </div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="u-save">Save</button>`,
    onMount: (bd) => {
      $('#u-save').onclick = async () => {
        const body = { fullName: $('#u-name').value.trim(), role: $('#u-role').value };
        if (!$('#u-pw').value && !u) return toast('Password required for new user', 'warn');
        if ($('#u-pw').value) body.password = $('#u-pw').value;
        if (!u) body.username = $('#u-user').value.trim();
        if (!body.username && !u) return toast('Username required', 'warn');
        try {
          if (u) await put(`/users/${u.id}`, body); else await post('/users', body);
          toast('User saved', 'ok'); closeModal(); navigate('settings');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// REGISTRATION
// ============================================================
Object.assign(RM_VIEWS, {
  pos: { label: 'POS', sidebar: posSidebar, render: posView, go: posAction },
  stock: { label: 'Stock', sidebar: '', render: stockView },
  invoices: { label: 'Invoices', sidebar: '', render: invoiceView },
  purchasing: { label: 'Purchasing', sidebar: '', render: purchasingView },
  customers: { label: 'Customers', sidebar: '', render: customersView },
  suppliers: { label: 'Suppliers', sidebar: '', render: suppliersView },
  accounting: { label: 'Accounting', sidebar: '', render: accountingView },
  reports: { label: 'Reports', sidebar: '', render: reportsView },
  eod: { label: 'Day Close', sidebar: '', render: eodView },
  settings: { label: 'Settings', sidebar: '', render: settingsView },
});

function posAction(action) {
  switch (action) {
    case 'clear': posActions.clearCart?.(); break;
    case 'pay': posActions.openPayment?.(); break;
    case 'orders': showRecentOrders(); break;
    case 'void': showRefund(); break;
    case 'refresh': refreshStock(); break;
    case 'layaway': showLayaway(); break;
    case 'quote': showQuote(); break;
  }
}

async function refreshStock() {
  await loadCatalog(); toast('Stock refreshed', 'ok'); navigate('pos');
}

async function showRecentOrders() {
  const orders = await get('/orders?type=SALE');
  const s = SETTINGS.currency;
  modal({
    title: 'Recent sales', wide: true,
    body: renderTable(orders.slice(0, 20), [
      { key: 'doc_no', label: 'Receipt' }, { key: 'created_at', label: 'Time', render: (r) => fmtDT(r.created_at) },
      { key: 'customer_name', label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
      { key: 'total_cents', label: 'Total', num: true, render: (r) => fmtCents(r.total_cents, s) },
      { key: 'status', label: 'Status', render: badgeFor },
    ], { empty: 'No sales yet' }),
    footer: `<button class="btn" onclick="closeModal()">Close</button>`,
  });
}

async function showRefund() {
  const orders = await get('/orders?type=SALE');
  const s = SETTINGS.currency;
  modal({
    title: 'Refund / void a sale', wide: true,
    body: `
      <div class="field"><label>Sale to refund</label><select id="rf-sale">
        ${orders.filter(o => o.status === 'PAID' && o.refunded_cents < o.total_cents).map(o =>
          `<option value="${o.id}">${esc(o.doc_no)} — ${fmtCents(o.total_cents, s)} (${fmtDT(o.created_at)})</option>`).join('')}
      </select></div>
      <div class="field"><label>Refund method</label><select id="rf-method"><option>CASH</option><option>CARD</option><option>MOBILE</option><option>BANK</option></select></div>
      <div class="field"><label>Reason</label><input id="rf-note"></div>
      <div class="field"><label>Items to refund (full refund by default)</label>
        <div id="rf-items">${orders.filter(o => o.status === 'PAID' && o.refunded_cents < o.total_cents).length ?
          '' : '<span class="muted">No refundable sales</span>'}</div></div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-danger" id="rf-go">Refund</button>`,
    onMount: (bd) => {
      const renderItems = () => {
        const sel = orders.find(o => o.id == $('#rf-sale').value);
        if (!sel) return $('#rf-items').innerHTML = '';
        $('#rf-items').innerHTML = sel.lines.map(l =>
          `<div class="fields-3" style="margin-bottom:4px">
            <div>${esc(l.product_name)}</div>
            <input type="number" min="0" max="${l.qty}" value="${l.qty}" data-pid="${l.product_id}" class="rf-qty">
            <span>${fmtCents(l.line_total_cents, s)}</span>
          </div>`).join('');
      };
      $('#rf-sale').onchange = renderItems;
      renderItems();
      $('#rf-go').onclick = async () => {
        try {
          const sold = orders.find(o => o.id == $('#rf-sale').value);
          const items = $$('.rf-qty').map(i => ({ productId: +i.dataset.pid, qty: +i.value })).filter(i => i.qty > 0);
          if (!items.length) return toast('Select items to refund', 'warn');
          await post('/pos/refund', { saleId: sold.id, items, method: $('#rf-method').value, reason: $('#rf-note').value });
          toast('Refund processed', 'ok'); await loadCatalog();
          closeModal(); navigate('pos');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function showLayaway() {
  if (!cart.length) return toast('Add items first', 'warn');
  const totals = computeTotals();
  if (!CATALOG.customers.length) await loadCatalog();
  modal({
    title: 'Layaway — hold goods with a deposit',
    body: `
      <div class="field"><label>Customer</label><select id="la-cust">
        ${CATALOG.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="fields-2">
        <div class="field"><label>Total</label><div style="font-size:20px; font-weight:800">${fmtCents(totals.total, SETTINGS.currency)}</div></div>
        <div class="field"><label>Deposit</label><input id="la-dep" type="number" value="${(totals.total / 100).toFixed(2)}" step="0.01"></div>
      </div>
      <div id="la-list" class="muted">${cart.map(c => `${esc(c.name)} × ${c.qty}`).join('<br>')}</div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="la-go">Start layaway</button>`,
    onMount: (bd) => {
      $('#la-go').onclick = async () => {
        const dep = toCents($('#la-dep').value);
        if (!dep || dep <= 0) return toast('Enter deposit', 'warn');
        try {
          await post('/pos/layaway', {
            customerId: +$('#la-cust').value, items: cart.map(l => ({ productId: l.productId, qty: l.qty })), deposit: dep,
          });
          toast('Layaway started', 'ok'); await loadCatalog(); cart = []; posCustomer = null; closeModal(); navigate('pos');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function showQuote() {
  if (!cart.length) return toast('Add items first', 'warn');
  if (!CATALOG.customers.length) await loadCatalog();
  modal({
    title: 'Customer quote',
    body: `
      <div class="field"><label>Customer</label><select id="qt-cust">
        ${CATALOG.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Note</label><input id="qt-note"></div>
      <div class="muted" style="margin-top:8px">${cart.map(c => `${esc(c.name)} × ${c.qty}`).join('<br>')}</div>`,
    footer: `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="qt-go">Create quote</button>`,
    onMount: (bd) => {
      $('#qt-go').onclick = async () => {
        try {
          await post('/pos/quote', { customerId: +$('#qt-cust').value, items: cart.map(l => ({ productId: l.productId, qty: l.qty })), note: $('#qt-note').value });
          toast('Quote created', 'ok'); await loadCatalog(); cart = []; posCustomer = null; closeModal(); navigate('pos');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ============================================================
// BOOTSTRAP
// ============================================================
async function init() {
  // login handlers
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-err'); err.textContent = '';
    try { await doLogin($('#login-user').value.trim(), $('#login-pass').value); }
    catch (ex) { err.textContent = ex.message; }
  });
  $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-form').requestSubmit(); });

  // persist session
  if (TOKEN) {
    try { USER = await get('/auth/me').then(d => d.user); if (USER) { showApp(); return; } } catch (_) {}
  }
  $('#login-screen').classList.remove('hidden');
}

init();
})();