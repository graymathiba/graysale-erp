// Supermarket POS frontend
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let session = { token: null, user: null };
const token = () => localStorage.getItem('smt_token') || '';
const storeToken = (t) => t ? localStorage.setItem('smt_token', t) : localStorage.removeItem('smt_token');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const api = {
  async request(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token()) headers['Authorization'] = 'Bearer ' + token();
    const res = await fetch('/api/v1' + path, {
      headers,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { showLogin(); throw new Error('UNAUTHORIZED'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || data.message || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get: (p) => api.request(p),
  post: (p, b) => api.request(p, { method: 'POST', body: b }),
  put: (p, b) => api.request(p, { method: 'PUT', body: b }),
  del: (p, b) => api.request(p, { method: 'DELETE', body: b }),
};

const fmt = (cents) => '$' + (cents / 100).toFixed(2);
const fmtQty = (q) => String(q % 1 === 0 ? q : q.toFixed(2));

// ---------- Auth / session ----------
const roleRank = (r) => ({ cashier: 1, manager: 2, admin: 3 }[r] || 0);
const isAdmin = () => session.user?.role === 'admin';

async function doLogin() {
  const uname = $('#loginUser').value.trim();
  const pass = $('#loginPass').value;
  $('#loginError').textContent = '';
  try {
    const res = await api.post('/auth/login', { username: uname, password: pass });
    session.token = res.token;
    session.user = res.user;
    storeToken(res.token);
    applySession();
    switchView('checkout');
  } catch (e) {
    $('#loginError').textContent = e.message === 'INVALID_CREDENTIALS' ? 'Invalid username or password' : (e.message || 'Login failed');
  }
}

async function doLogout() {
  try { await api.post('/auth/logout', {}); } catch (_) {}
  session = { token: null, user: null };
  storeToken(null);
  showLogin();
}

function showLogin() {
  $('#loginOverlay').classList.add('show');
  $('#app').classList.add('blurred');
}

function applySession() {
  $('#loginOverlay').classList.remove('show');
  $('#app').classList.remove('blurred');
  $('#currentUser').textContent = (session.user?.fullName || session.user?.username) + ' / ' + (session.user?.role || '');
  $$('.admin-only').forEach(el => el.style.display = isAdmin() ? '' : 'none');
  $$('.manager-only').forEach(el => el.style.display = (roleRank(session.user?.role) >= 2) ? '' : 'none');
}

// ---------- Toast ----------
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- Navigation ----------
function switchView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  const target = $('#view-' + name);
  if (!target) return;
  target.classList.add('active');
  if (name === 'checkout') renderCheckout();
  if (name === 'dashboard') loadDashboard();
  if (name === 'products') loadProducts();
  if (name === 'inventory') loadInventory();
  if (name === 'customers') loadCustomers();
  if (name === 'sales') loadSales();
  if (name === 'accounting') loadAccounting();
  if (name === 'agents') loadAgents();
  if (name === 'users') loadUsers();
  if (name === 'audit') loadAudit();
}

$$('.nav-item').forEach(b => b.addEventListener('click', () => {
  switchView(b.dataset.view);
  $('#app').classList.remove('sidebar-open');
}));

// ---------- Keyboard shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === 'F2') { e.preventDefault(); switchView('checkout'); }
  if (e.key === 'F3') { e.preventDefault(); switchView('dashboard'); }
  if (e.key === 'Escape') {
    const receipt = $('#receipt');
    if (receipt && receipt.classList.contains('show')) receipt.classList.remove('show');
  }
});

// ---------- CHECKOUT ----------
const cart = new Map();
let cartCustomer = null;
let cartRedeemPoints = 0;

function renderCheckout() {
  api.get('/products').then(products => {
    const container = $('#view-checkout');
    container.innerHTML = `
      <div class="checkout-grid">
        <div>
          <input class="search-bar" id="prodSearch" placeholder="Search products or scan barcode...">
          <div class="product-grid" id="productGrid"></div>
        </div>
        <div class="cart-panel">
          <div class="flex-between">
            <h3>Current Cart</h3>
            <button class="btn btn-secondary" id="clearCart">Clear</button>
          </div>
          <div class="cart-list" id="cartList"></div>
          <div class="cart-totals">
            <div class="tot-row"><span>Subtotal</span><span id="cts-subtotal"></span></div>
            <div class="tot-row"><span>Discount</span><span id="cts-discount"></span></div>
            <div class="tot-row"><span>Tax</span><span id="cts-tax"></span></div>
            <div class="tot-row total"><span>Total</span><span id="cts-total"></span></div>
          </div>
          <div class="form-grid mt">
            <label>Customer <select id="cartCustomer"></select></label>
            <label>Redeem Pts <input type="number" id="cartPoints" min="0" value="0" placeholder="0"></label>
          </div>
          <div class="checkout-actions">
            <button class="btn btn-green" id="cashCheckout">Pay Cash</button>
            <button class="btn btn-primary" id="cardCheckout">Pay Card</button>
            <button class="btn btn-secondary" id="printReceiptBtn">Print Receipt</button>
          </div>
        </div>
      </div>`;

    window._products = products;
    renderProductGrid(products);
    loadCustomerOptions();

    $('#prodSearch').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const filtered = products.filter(p =>
        p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q)) || p.sku.toLowerCase().includes(q));
      renderProductGrid(filtered);
    });

    $('#clearCart').addEventListener('click', () => { cart.clear(); cartCustomer = null; cartRedeemPoints = 0; renderCart(); });
    $('#cartCustomer').addEventListener('change', (e) => { cartCustomer = e.target.value ? Number(e.target.value) : null; });
    $('#cartPoints').addEventListener('input', (e) => { cartRedeemPoints = Number(e.target.value) || 0; renderCart(); });
    $('#cashCheckout').addEventListener('click', () => {
      const total = totalCents().total / 100;
      const amount = prompt('Cash received ($):', total.toFixed(2));
      if (amount === null) return;
      doCheckout('cash', Math.round(parseFloat(amount) * 100));
    });
    $('#cardCheckout').addEventListener('click', () => doCheckout('card', null));
    $('#printReceiptBtn').addEventListener('click', () => printReceipt());

    renderCart();
  }).catch(e => toast(e.message, 'error'));
}

function renderProductGrid(products) {
  const grid = $('#productGrid');
  grid.innerHTML = products.map(p => `
    <button class="product-btn" data-id="${p.id}">
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-price">${fmt(p.price_cents)}</span>
      <span class="p-stock ${(p.quantity ?? 0) <= (p.reorder_level ?? 0) ? 'low' : ''}">${fmtQty(p.quantity ?? 0)} in stock</span>
    </button>`).join('');
  grid.querySelectorAll('.product-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const p = window._products.find(x => x.id === Number(btn.dataset.id));
      if ((p.quantity ?? 0) <= (cart.get(p.id)?.qty || 0)) { toast('Out of stock', 'error'); return; }
      addToCart(p, 1);
    }));
}

function addToCart(product, qty) {
  const existing = cart.get(product.id);
  const current = existing ? existing.qty : 0;
  if (product.quantity != null && current + qty > product.quantity) { toast('Not enough stock', 'error'); return; }
  cart.set(product.id, { product, qty: current + qty });
  renderCart();
}

function totalCents() {
  let sub = 0, tax = 0;
  for (const { product, qty } of cart.values()) {
    sub += product.price_cents * qty;
    tax += Math.round(product.price_cents * qty * (product.tax_rate || 0));
  }
  const redeemCents = Math.floor(cartRedeemPoints / 100) * 100;
  const discount = Math.min(redeemCents, sub);
  return { subtotal: sub, discount, tax, total: sub - discount + tax };
}

function renderCart() {
  const list = $('#cartList');
  if (!list) return;
  const t = totalCents();
  if (cart.size === 0) { list.innerHTML = '<div class="muted" style="text-align:center;padding:20px">Cart is empty</div>'; }
  else {
    list.innerHTML = [...cart.values()].map(({ product, qty }) => `
      <div class="cart-item">
        <span class="ci-name">${esc(product.name)}<br><span class="muted" style="font-size:11px">${fmt(product.price_cents)} ea</span></span>
        <div class="ci-qty">
          <button class="qty-btn" data-id="${product.id}" data-d="-1">-</button>
          <span>${fmtQty(qty)}</span>
          <button class="qty-btn" data-id="${product.id}" data-d="1">+</button>
          <button class="qty-btn" data-id="${product.id}" data-d="0" title="remove">X</button>
        </div>
        <span class="ci-line">${fmt(product.price_cents * qty)}</span>
      </div>`).join('');
    list.querySelectorAll('.qty-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const d = Number(btn.dataset.d);
        const cur = cart.get(id);
        if (d === 0) cart.delete(id);
        else { const n = cur.qty + d; if (n <= 0) cart.delete(id); else cart.set(id, { ...cur, qty: n }); }
        renderCart();
      }));
  }
  $('#cts-subtotal').textContent = fmt(t.subtotal);
  $('#cts-discount').textContent = '-' + fmt(t.discount);
  $('#cts-tax').textContent = fmt(t.tax);
  $('#cts-total').textContent = fmt(t.total);
}

function loadCustomerOptions() {
  api.get('/customers').then(customers => {
    const sel = $('#cartCustomer');
    if (!sel) return;
    sel.innerHTML = '<option value="">Walk-in</option>' + customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }).catch(() => {});
}

async function doCheckout(method, cashReceived) {
  if (cart.size === 0) { toast('Cart is empty', 'error'); return; }
  const items = [...cart.values()].map(({ product, qty }) => ({ productId: product.id, qty }));
  const payload = {
    items,
    customerId: cartCustomer,
    redeemPoints: cartRedeemPoints,
    paymentMethod: method,
  };
  if (method === 'cash' && cashReceived != null) payload.cashReceivedCents = cashReceived;
  try {
    const res = await api.post('/checkout', payload);
    window._lastSale = res;
    toast('Sale completed. Receipt ' + res.receiptNo);
    cart.clear();
    cartCustomer = null;
    cartRedeemPoints = 0;
    renderCheckout();
  } catch (e) {
    toast(e.message || 'Checkout failed', 'error');
  }
}

function printReceipt() {
  const sale = window._lastSale;
  const box = $('#receipt');
  if (!sale) { toast('No recent sale to print', 'error'); return; }
  box.innerHTML = `
    <div class="receipt-box">
      <div class="r-header"><strong>GraySale ERP</strong><br><small>Receipt #${esc(String(sale.receiptNo))}</small></div>
      ${(sale.lines || []).map(l => `<div class="r-line"><span>${esc(l.name)} x ${fmtQty(l.qty)}</span><span>${fmt(l.lineTotalCents)}</span></div>`).join('')}
      <div class="r-line"><span>Tax</span><span>${fmt(sale.taxCents)}</span></div>
      <div class="r-total"><span>Total</span><span>${fmt(sale.totalCents)}</span></div>
    </div>`;
  box.classList.add('show');
}

// ---------- DASHBOARD ----------
async function loadDashboard() {
  const box = $('#view-dashboard');
  box.innerHTML = '<div class="muted">Loading dashboard...</div>';
  try {
    const stats = await api.get('/dashboard');
    const [top, daily] = await Promise.all([
      api.get('/reports/top-products'),
      api.get('/reports/daily'),
    ]);
    const t = stats.today || {};
    const totalRevenue = daily.reduce((s, d) => s + d.revenue_cents, 0);
    box.innerHTML = `
      <div class="table-toolbar"><h2>Dashboard</h2><button class="btn btn-secondary" onclick="loadDashboard()">Refresh</button></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Today's Sales</div><div class="value">${t.count ?? 0}</div><div class="sub">transactions on ${esc(t.sale_date || 'today')}</div></div>
        <div class="stat-card"><div class="label">Today's Revenue</div><div class="value">${fmt(t.revenue_cents ?? 0)}</div><div class="sub">${fmt(t.profit_cents ?? 0)} profit</div></div>
        <div class="stat-card"><div class="label">Total Revenue</div><div class="value">${fmt(totalRevenue)}</div><div class="sub">${daily.length} days</div></div>
      </div>
      <div class="two-col">
        <div class="card">
          <h3>Top Products</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Product</th><th>Units</th><th>Revenue</th></tr></thead>
            <tbody>${top.map(p => `<tr><td>${esc(p.product_name)}</td><td>${fmtQty(p.units_sold)}</td><td>${fmt(p.revenue_cents)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No sales yet</td></tr>'}</tbody>
          </table></div>
        </div>
        <div class="card">
          <h3>Daily Sales</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Count</th><th>Revenue</th><th>Profit</th></tr></thead>
            <tbody>${daily.slice(0, 15).map(d => `<tr><td>${esc(d.sale_date)}</td><td>${d.count}</td><td>${fmt(d.revenue_cents)}</td><td>${fmt(d.profit_cents)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No data</td></tr>'}</tbody>
          </table></div>
        </div>
      </div>`;
  } catch (e) { box.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

// ---------- PRODUCTS ----------
async function loadProducts() {
  const box = $('#view-products');
  box.innerHTML = '<div class="muted">Loading products...</div>';
  try {
    const products = await api.get('/products');
    box.innerHTML = `
      <div class="table-toolbar"><h2>Products (${products.length})</h2>
        <button class="btn btn-primary" onclick="showProductModal()">New Product</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>SKU</th><th>Barcode</th><th>Category</th><th>Price</th><th>Cost</th><th>Tax</th><th>Stock</th><th></th></tr></thead>
        <tbody>${products.map(p => `
          <tr>
            <td>${esc(p.name)}</td><td>${esc(p.sku)}</td><td>${esc(p.barcode || '')}</td><td>${esc(p.category)}</td>
            <td>${fmt(p.price_cents)}</td><td>${fmt(p.cost_cents)}</td><td>${(p.tax_rate * 100).toFixed(0)}%</td>
            <td>${fmtQty(p.quantity ?? 0)}</td>
            <td><button class="btn btn-secondary" onclick="showProductModal(${p.id})">Edit</button></td>
          </tr>`).join('') || '<tr><td colspan="9" class="muted">No products</td></tr>'}</tbody>
      </table></div>`;
  } catch (e) { box.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

function showProductModal(id) {
  const products = window._products || [];
  const p = id != null ? products.find(x => x.id === id) : null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>${p ? 'Edit Product: ' + esc(p.name) : 'New Product'}</h3>
      <div class="form-grid">
        <label>Name <input id="pm-name" value="${p ? esc(p.name) : ''}"></label>
        <label>SKU <input id="pm-sku" value="${p ? esc(p.sku) : ''}"></label>
        <label>Barcode <input id="pm-barcode" value="${p ? esc(p.barcode || '') : ''}"></label>
        <label>Category <input id="pm-cat" value="${p ? esc(p.category) : 'General'}"></label>
        <label>Price ($) <input id="pm-price" type="number" value="${p ? (p.price_cents / 100).toFixed(2) : ''}"></label>
        <label>Cost ($) <input id="pm-cost" type="number" value="${p ? (p.cost_cents / 100).toFixed(2) : ''}"></label>
        <label>Tax Rate <input id="pm-tax" type="number" step="0.01" value="${p ? p.tax_rate : 0.08}"></label>
        <label>Initial Stock <input id="pm-stock" type="number" value="${p ? (p.quantity ?? 0) : 0}"></label>
      </div>
      <div class="flex mt" style="justify-content:flex-end">
        <button class="btn btn-secondary" id="pm-cancel">Cancel</button>
        <button class="btn btn-primary" id="pm-save">Save</button>
      </div>
    </div>`;
  overlay.id = 'productModal';
  document.body.appendChild(overlay);
  $('#pm-cancel').addEventListener('click', () => overlay.remove());
  $('#pm-save').addEventListener('click', async () => {
    const body = {
      name: $('#pm-name').value,
      sku: $('#pm-sku').value,
      barcode: $('#pm-barcode').value || null,
      category: $('#pm-cat').value,
      price_cents: Math.round(parseFloat($('#pm-price').value || 0) * 100),
      cost_cents: Math.round(parseFloat($('#pm-cost').value || 0) * 100),
      tax_rate: parseFloat($('#pm-tax').value) || 0,
      quantity: p ? undefined : (parseInt($('#pm-stock').value) || 0),
    };
    try {
      if (p) await api.put('/products/' + p.id, body);
      else await api.post('/products', body);
      toast('Product saved');
      overlay.remove();
      loadProducts();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- INVENTORY ----------
async function loadInventory() {
  const box = $('#view-inventory');
  box.innerHTML = '<div class="muted">Loading inventory...</div>';
  try {
    const [products, low] = await Promise.all([
      api.get('/inventory'),
      api.get('/products/low'),
    ]);
    box.innerHTML = `
      <div class="table-toolbar"><h2>Inventory</h2></div>
      ${low.length ? `<div class="agent-result fail mb"><strong>Low Stock Alerts:</strong> ${low.map(l => esc(l.name) + ' (' + fmtQty(l.quantity) + ')').join(', ')}</div>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Quantity</th><th>Reorder Level</th><th>Status</th><th>Adjust</th></tr></thead>
        <tbody>${products.map(p => `
          <tr>
            <td>${esc(p.name)}</td>
            <td>${fmtQty(p.quantity ?? 0)}</td>
            <td>${fmtQty(p.reorder_level ?? 0)}</td>
            <td>${(p.quantity ?? 0) <= (p.reorder_level ?? 0) ? '<span class="badge badge-red">LOW</span>' : '<span class="badge badge-green">OK</span>'}</td>
            <td><button class="btn btn-secondary" onclick="showAdjustModal(${p.id}, ${esc(JSON.stringify(p.name))}, ${p.quantity ?? 0})">Adjust</button></td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No inventory</td></tr>'}</tbody>
      </table></div>`;
  } catch (e) { box.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

function showAdjustModal(productId, name, qty) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Adjust Inventory: ${esc(name)}</h3>
      <p class="muted">Current stock: ${fmtQty(qty)}</p>
      <div class="form-grid">
        <label>Delta (+/-) <input type="number" id="adj-delta" placeholder="e.g. 10 or -5"></label>
        <label>Type
          <select id="adj-type"><option value="ADJUST">ADJUST</option><option value="STOCKTAKE">STOCKTAKE</option><option value="DAMAGE">DAMAGE</option><option value="RETURN">RETURN</option></select>
        </label>
      </div>
      <label class="mt">Note <input id="adj-note"></label>
      <div class="flex mt" style="justify-content:flex-end">
        <button class="btn btn-secondary" id="adj-cancel">Cancel</button>
        <button class="btn btn-primary" id="adj-save">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#adj-cancel').addEventListener('click', () => overlay.remove());
  $('#adj-save').addEventListener('click', async () => {
    try {
      await api.post('/inventory/adjust', {
        productId,
        delta: parseInt($('#adj-delta').value),
        type: $('#adj-type').value,
        note: $('#adj-note').value,
      });
      toast('Inventory adjusted');
      overlay.remove();
      loadInventory();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- CUSTOMERS ----------
async function loadCustomers() {
  const box = $('#view-customers');
  box.innerHTML = '<div class="muted">Loading customers...</div>';
  try {
    const customers = await api.get('/customers');
    box.innerHTML = `
      <div class="table-toolbar"><h2>Customers (${customers.length})</h2>
        <button class="btn btn-primary" onclick="showCustomerModal()">New Customer</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Loyalty Pts</th><th>Total Spent</th></tr></thead>
        <tbody>${customers.map(c => `
          <tr><td>${esc(c.name)}</td><td>${esc(c.phone || '')}</td><td>${esc(c.email || '')}</td><td>${c.loyalty_points}</td><td>${fmt(c.total_spent_cents || 0)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No customers</td></tr>'}</tbody>
      </table></div>`;
  } catch (e) { box.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

function showCustomerModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>New Customer</h3>
      <div class="form-grid">
        <label>Name <input id="cu-name"></label>
        <label>Phone <input id="cu-phone"></label>
        <label>Email <input id="cu-email"></label>
      </div>
      <div class="flex mt" style="justify-content:flex-end">
        <button class="btn btn-secondary" id="cu-cancel">Cancel</button>
        <button class="btn btn-primary" id="cu-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#cu-cancel').addEventListener('click', () => overlay.remove());
  $('#cu-save').addEventListener('click', async () => {
    try {
      await api.post('/customers', {
        name: $('#cu-name').value,
        phone: $('#cu-phone').value || null,
        email: $('#cu-email').value || null,
      });
      toast('Customer created');
      overlay.remove();
      loadCustomers();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- SALES ----------
let _salesCache = [];
async function loadSales() {
  const box = $('#view-sales');
  box.innerHTML = '<div class="muted">Loading sales...</div>';
  try {
    const res = await api.get('/sales');
    const sales = res.data || res;
    _salesCache = sales;
    box.innerHTML = `
      <div class="table-toolbar"><h2>Sales History (${sales.length})</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Receipt</th><th>Date</th><th>Items</th><th>Total</th><th>Method</th><th>Status</th><th></th></tr></thead>
        <tbody>${sales.map(s => `
          <tr>
            <td>${esc(s.receipt_no)}</td>
            <td>${esc(String(s.created_at).slice(0, 16).replace('T', ' '))}</td>
            <td>${s.item_count ?? ''}</td>
            <td>${fmt(s.total_cents)}</td>
            <td>${esc(s.payment_method || '')}</td>
            <td>${s.status === 'void' ? '<span class="badge badge-red">VOID</span>' : '<span class="badge badge-green">COMPLETE</span>'}</td>
            <td>${s.status !== 'void' ? `<button class="btn btn-danger" onclick="voidSale(${s.id})">Void</button>` : ''}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">No sales yet</td></tr>'}</tbody>
      </table></div>`;
  } catch (e) { box.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

async function voidSale(id) {
  const sale = _salesCache.find(s => s.id === id);
  const reason = prompt('Reason for voiding receipt ' + (sale ? sale.receipt_no : id) + ':', 'Voided by ' + (session.user?.username || 'user'));
  if (reason === null) return;
  try {
    await api.post('/sales/void', { saleId: id, reason });
    toast('Sale voided');
    loadSales();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- ACCOUNTING ----------
let _acctTab = 'chart';
async function loadAccounting() {
  const box = $('#view-accounting');
  box.innerHTML = `
    <div class="tabs" id="acctTabs">
      <button class="tab" data-tab="chart">Chart of Accounts</button>
      <button class="tab" data-tab="ledger">Ledger</button>
      <button class="tab" data-tab="tb">Trial Balance</button>
      <button class="tab" data-tab="pl">P&L</button>
      <button class="tab" data-tab="bs">Balance Sheet</button>
      <button class="tab" data-tab="verify">Verify</button>
    </div>
    <div id="acctContent"><div class="muted">Loading...</div></div>`;
  $('#acctTabs').querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    _acctTab = t.dataset.tab;
    $('#acctTabs').querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    loadAcctTab();
  }));
  $('#acctTabs').querySelector(`.tab[data-tab="${_acctTab}"]`).classList.add('active');
  loadAcctTab();
}

async function loadAcctTab() {
  const content = $('#acctContent');
  try {
    if (_acctTab === 'chart') {
      const chart = await api.get('/accounting/chart');
      content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Balance</th></tr></thead><tbody>${chart.map(a => `<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.type)}</td><td>${fmt(a.balance_cents)}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (_acctTab === 'ledger') {
      const ledger = await api.get('/accounting/ledger');
      content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Entry</th><th>Reference</th><th>Account</th><th>Debits</th><th>Credits</th></tr></thead><tbody>${(ledger.lines || ledger || []).map(l => `<tr><td>${esc(l.entry_no || '')}</td><td>${esc(l.reference || '')}</td><td>${esc(l.account_code || l.account_id || '')}</td><td>${fmt(l.debits_cents)}</td><td>${fmt(l.credits_cents)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No entries</td></tr>'}</tbody></table></div>`;
    } else if (_acctTab === 'tb') {
      const tb = await api.get('/accounting/trial-balance');
      content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Code</th><th>Debits</th><th>Credits</th></tr></thead><tbody>${tb.map(r => `<tr><td>${esc(r.name || r.account || '')}</td><td>${esc(r.code || '')}</td><td>${fmt(r.total_debits ?? r.debits_cents ?? 0)}</td><td>${fmt(r.total_credits ?? r.credits_cents ?? 0)}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (_acctTab === 'pl') {
      const pl = await api.get('/accounting/pl');
      content.innerHTML = `<pre class="agent-pre">${esc(JSON.stringify(pl, null, 2))}</pre>`;
    } else if (_acctTab === 'bs') {
      const bs = await api.get('/accounting/balance-sheet');
      content.innerHTML = `<pre class="agent-pre">${esc(JSON.stringify(bs, null, 2))}</pre>`;
    } else if (_acctTab === 'verify') {
      const v = await api.get('/accounting/verify');
      content.innerHTML = `<div class="agent-result ${v.balanced ? 'pass' : 'fail'}"><strong>${v.balanced ? 'Balanced' : 'IMBALANCED'}</strong><br>Debits: ${fmt(v.debits)}<br>Credits: ${fmt(v.credits)}</div>`;
    }
  } catch (e) { content.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

// ---------- AGENTS ----------
let _agentTab = 'list';
async function loadAgents() {
  const box = $('#view-agents');
  box.innerHTML = `
    <div class="tabs" id="agentTabs">
      <button class="tab" data-tab="list">Agents</button>
      <button class="tab" data-tab="message">Send Message</button>
      <button class="tab" data-tab="history">History</button>
      <button class="tab" data-tab="approvals">Approvals</button>
    </div>
    <div id="agentContent"><div class="muted">Loading...</div></div>`;
  $('#agentTabs').querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    _agentTab = t.dataset.tab;
    $('#agentTabs').querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    loadAgentTab();
  }));
  $('#agentTabs').querySelector(`.tab[data-tab="${_agentTab}"]`).classList.add('active');
  loadAgentTab();
}

async function loadAgentTab() {
  const content = $('#agentContent');
  const agentCard = (a) => `
    <div class="agent-card">
      <div class="agent-card-head"><strong>${esc(a.name)}</strong><span class="badge ${a.status === 'idle' ? 'badge-green' : 'badge-blue'}">${esc(a.status || '')}</span></div>
      <div class="agent-meta muted">${esc(a.role || '')} | Messages: ${a.messageCount ?? 0} | Errors: ${a.errorCount ?? 0}</div>
      <div class="cap-tags">${(a.capabilities || []).map(c => `<span>${esc(c)}</span>`).join('')}</div>
    </div>`;
  try {
    if (_agentTab === 'list') {
      const agents = await api.get('/agents');
      content.innerHTML = agents.map(agentCard).join('') || '<div class="muted">No agents</div>';
    } else if (_agentTab === 'history') {
      const hist = await api.get('/agents/history?limit=50');
      content.innerHTML = hist.map(h => `<div class="hist-row"><code>${esc(h.direction || '')}</code> <strong>${esc(h.domain || '')}</strong> ${h.result ? '<span class="muted">' + esc(h.result) + '</span>' : ''} <span class="muted">${esc(h.from || '')}</span></div>`).join('') || '<div class="muted">No history</div>';
    } else if (_agentTab === 'approvals') {
      const approvals = await api.get('/approvals');
      content.innerHTML = approvals.map(a => `
        <div class="agent-card approval-item approval-pending">
          <div class="approval-header"><strong>${esc(a.action)}</strong><span class="muted">${esc(a.agent_name)}</span></div>
          <div class="approval-body">${esc(a.detail || '')}</div>
          <div class="approval-actions">
            <button class="btn btn-green" onclick="decideApproval('${a.id}', true)">Approve</button>
            <button class="btn btn-danger" onclick="decideApproval('${a.id}', false)">Reject</button>
          </div>
        </div>`).join('') || '<div class="muted">No pending approvals</div>';
    } else if (_agentTab === 'message') {
      content.innerHTML = `
        <div class="card">
          <h3>Send Agent Message</h3>
          <div class="form-grid">
            <label>Domain <input id="am-domain" placeholder="e.g. finance.get_balance"></label>
            <label>Type <select id="am-type"><option value="COMMAND">COMMAND</option><option value="QUERY">QUERY</option></select></label>
          </div>
          <label class="mt">Payload (JSON) <textarea id="am-payload" rows="4">{"accountCode":"1000"}</textarea></label>
          <button class="btn btn-primary mt" id="am-send">Send</button>
          <div id="am-result" class="mt"></div>
        </div>`;
      $('#am-send').addEventListener('click', async () => {
        const domain = $('#am-domain').value.trim();
        let payload = {};
        try { payload = JSON.parse($('#am-payload').value || '{}'); } catch { toast('Invalid JSON payload', 'error'); return; }
        try {
          const res = await api.post('/agents/message', { domain, type: $('#am-type').value, payload });
          $('#am-result').innerHTML = `<pre class="agent-pre">${esc(JSON.stringify(res, null, 2))}</pre>`;
        } catch (e) { $('#am-result').innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
      });
    }
  } catch (e) { content.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

async function decideApproval(id, approve) {
  try {
    await api.post('/approvals/' + id + '/' + (approve ? 'approve' : 'reject'), {});
    toast(approve ? 'Approved' : 'Rejected');
    loadAgentTab();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- USERS (admin) ----------
async function loadUsers() {
  const box = $('#view-users');
  box.innerHTML = '<div class="muted">Loading users...</div>';
  try {
    const [users, allCaps] = await Promise.all([
      api.get('/users'),
      api.get('/users/capabilities'),
    ]);
    // For each user load their capability breakdown
    const usersWithCaps = await Promise.all(users.map(async u => {
      const caps = await api.get('/users/' + u.id + '/capabilities').catch(() => []);
      return { ...u, caps };
    }));
    box.innerHTML = `
      <div class="table-toolbar"><h2>Users (${users.length})</h2>
        <button class="btn btn-primary" onclick="showUserModal()">New User</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Active</th><th>Permissions</th><th></th></tr></thead>
        <tbody>${usersWithCaps.map(u => `
          <tr>
            <td>${esc(u.username)}</td>
            <td>${esc(u.full_name)}</td>
            <td><span class="badge ${u.role === 'admin' ? 'badge-red' : u.role === 'manager' ? 'badge-blue' : 'badge-green'}">${esc(u.role)}</span></td>
            <td>${u.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Disabled</span>'}</td>
            <td>${renderCapBadges(u.caps)}</td>
            <td><button class="btn btn-secondary" onclick="manageUserPerms(${u.id})">Manage Perms</button></td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No users</td></tr>'}</tbody>
      </table></div>`;
    window._allCaps = allCaps;
  } catch (e) { box.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

function renderCapBadges(caps) {
  if (!caps || !caps.length) return '<span class="muted">none</span>';
  return '<div class="cap-tags">' + caps.map(c => {
    const cls = c.source === 'grant' ? 'grant-cap' : 'role-cap';
    return `<span class="${cls}" title="${c.source === 'grant' ? 'Granted by ' + (c.granterName || 'admin') : 'From role'}">${esc(c.capability)}</span>`;
  }).join('') + '</div>';
}

async function manageUserPerms(userId) {
  const allCaps = window._allCaps || [];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal modal-wide"><div class="muted" id="perm-loading">Loading permissions...</div></div>`;
  document.body.appendChild(overlay);
  try {
    const [user] = await api.get('/users').then(us => [us.find(x => x.id === userId)]);
    const caps = await api.get('/users/' + userId + '/capabilities');

    // Group capabilities: those the user already has (via role or grant) and those they don't
    const grantedSet = new Set(caps.filter(c => c.source === 'grant').map(c => c.capability));
    const held = new Set([...caps.map(c => c.capability)]);
    const grantedList = [...grantedSet].sort();
    const grantableList = (allCaps.map(c => c.name))
      .filter(c => !held.has(c))
      .sort();

    overlay.innerHTML = `
      <div class="modal modal-wide">
        <div class="flex-between"><h3>Manage Permissions: ${esc(user.username)}</h3></div>
        <p class="muted">Role: <strong>${esc(user.role)}</strong>. Capabilities from role cannot be revoked; they are always active. Additional capabilities can be granted or revoked.</p>

        <h4 class="mt">Granted Capabilities (${grantedList.length})</h4>
        <div class="cap-tags mb">
          ${grantedList.length ? grantedList.map(c => `<span class="grant-cap" title="Click to revoke" style="cursor:pointer;border:1px solid var(--red);color:var(--red)" data-revoke="${c}">${esc(c)} &times;</span>`).join('') : '<span class="muted">No additional grants</span>'}
        </div>

        <h4>Grant New Capability</h4>
        <div class="flex">
          <select id="grantCapSelect" style="flex:1;padding:10px">
            <option value="">-- Select capability --</option>
            ${grantableList.map(c => {
              const meta = allCaps.find(x => x.name === c);
              return `<option value="${esc(c)}">${esc(c)} (min role: ${esc(meta?.minRole || '?')})</option>`;
            }).join('')}
          </select>
          <button class="btn btn-primary" id="grantCapBtn">Grant</button>
        </div>
        <div id="grantMsg" class="mt"></div>
        <div class="flex mt" style="justify-content:flex-end"><button class="btn btn-secondary" id="perm-close">Close</button></div>
      </div>`;

    overlay.querySelectorAll('[data-revoke]').forEach(span => span.addEventListener('click', async () => {
      const cap = span.dataset.revoke;
      try {
        await api.post('/users/' + userId + '/capabilities/revoke', { capability: cap });
        toast('Revoked ' + cap);
        overlay.remove();
        manageUserPerms(userId);
        loadUsers();
      } catch (e) { toast(e.message, 'error'); }
    }));

    $('#grantCapBtn').addEventListener('click', async () => {
      const cap = $('#grantCapSelect').value;
      if (!cap) { $('#grantMsg').innerHTML = '<div class="agent-result fail">Select a capability</div>'; return; }
      try {
        await api.post('/users/' + userId + '/capabilities/grant', { capability: cap });
        $('#grantMsg').innerHTML = '<div class="agent-result pass">Granted ' + esc(cap) + '</div>';
        setTimeout(() => { overlay.remove(); manageUserPerms(userId); loadUsers(); }, 800);
      } catch (e) { $('#grantMsg').innerHTML = '<div class="agent-result fail">' + esc(e.message) + '</div>'; }
    });

    $('#perm-close').addEventListener('click', () => overlay.remove());
  } catch (e) {
    overlay.innerHTML = `<div class="modal modal-wide"><div class="agent-result fail">${esc(e.message)}</div><div class="flex mt" style="justify-content:flex-end"><button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button></div></div>`;
  }
}

function showUserModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>New User</h3>
      <div class="form-grid">
        <label>Username <input id="um-username"></label>
        <label>Full Name <input id="um-fullname"></label>
        <label>Role
          <select id="um-role"><option value="cashier">cashier</option><option value="manager">manager</option><option value="admin">admin</option></select>
        </label>
        <label>Password <input type="password" id="um-password" placeholder="8+ chars, upper/lower/digit"></label>
      </div>
      <div class="flex mt" style="justify-content:flex-end">
        <button class="btn btn-secondary" id="um-cancel">Cancel</button>
        <button class="btn btn-primary" id="um-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#um-cancel').addEventListener('click', () => overlay.remove());
  $('#um-save').addEventListener('click', async () => {
    try {
      await api.post('/users/create', {
        username: $('#um-username').value.trim(),
        fullName: $('#um-fullname').value,
        role: $('#um-role').value,
        password: $('#um-password').value,
      });
      toast('User created');
      overlay.remove();
      loadUsers();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- AUDIT ----------
async function loadAudit() {
  const box = $('#view-audit');
  box.innerHTML = '<div class="muted">Loading audit log...</div>';
  try {
    const audit = await api.get('/audit?limit=100');
    box.innerHTML = `
      <div class="table-toolbar"><h2>Audit Log</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
        <tbody>${audit.map(a => `
          <tr><td>${esc(String(a.created_at).slice(0, 19).replace('T', ' '))}</td><td>${esc(a.username || '')}</td><td>${esc(a.action)}</td><td>${esc(a.entity || '')}${a.entity_id ? ' #' + a.entity_id : ''}</td><td>${esc(a.detail || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No audit entries</td></tr>'}</tbody>
      </table></div>`;
  } catch (e) { box.innerHTML = `<div class="agent-result fail">${esc(e.message)}</div>`; }
}

// ---------- Modal helpers ----------
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) e.target.remove();
});

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', () => {
  $('#loginBtn').addEventListener('click', doLogin);
  $('#loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#logoutBtn').addEventListener('click', doLogout);
  $('#backupBtn').addEventListener('click', async () => {
    try { await api.post('/backup', {}); toast('Backup complete'); } catch (e) { toast(e.message, 'error'); }
  });
  $('#menuBtn').addEventListener('click', () => $('#app').classList.add('sidebar-open'));

  // Restore session
  const saved = token();
  if (saved) {
    api.get('/auth/me').then(({ user }) => {
      session.token = saved;
      session.user = user;
      applySession();
      switchView('checkout');
    }).catch(() => showLogin());
  } else {
    showLogin();
  }
});
