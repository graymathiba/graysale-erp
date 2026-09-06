import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import usePOSHardware from '../hooks/usePOSHardware';
import LaybyPaymentModal from './LaybyPaymentModal';
import { buildPosReceipt, buildLaybyReceipt } from '../lib/thermalPrinter';
import { fmtMoney, fmtDT, initials } from '../lib/format';
import '../styles/pos-terminal.css';

const PAY_LABELS = { CASH: 'CASH', CARD: 'CARD', MOBILE: 'MOBILE', BANK: 'BANK' };
const CAT_TINTS = [
  { soft: '#dcfce7', hard: '#16a34a' },
  { soft: '#fef3c7', hard: '#d97706' },
  { soft: '#e0f2fe', hard: '#0369a1' },
  { soft: '#ede9fe', hard: '#6d28d9' },
  { soft: '#ffe4e6', hard: '#be123c' },
  { soft: '#e2e8f0', hard: '#334155' },
];
const FALLBACK_DEPTS = ['Hardware', 'Keys', 'Fishing', 'Ammo', 'General'];

export default function ClassicPOSTerminal() {
  const { user, can } = useAuth();
  const toast = useToast();

  // ---------- shift ----------
  const [shift, setShift] = useState(null);
  const [openShift, setOpenShift] = useState(false);
  const [shiftFloat, setShiftFloat] = useState('');

  // ---------- catalogue ----------
  const [cats, setCats] = useState([]);
  const [activeCat, setActiveCat] = useState(null); // category name or null=All
  const [fastItems, setFastItems] = useState([]);
  const [prodQuery, setProdQuery] = useState('');
  const productMapRef = useRef(new Map());

  // ---------- cart ----------
  const [cart, setCart] = useState([]);
  const [sel, setSel] = useState(-1);
  const [discPct, setDiscPct] = useState(0);
  const [qtyEntry, setQtyEntry] = useState('');
  const [saleTier, setSaleTier] = useState(''); // '' = retail (no tier)

  // ---------- customer ----------
  const [customer, setCustomer] = useState(null);
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState([]);
  const [custAdd, setCustAdd] = useState(false);
  const [custForm, setCustForm] = useState({ name: '', phone: '', email: '', taxId: '', debtLimit: '' });

  // ---------- payment ----------
  const [payMethod, setPayMethod] = useState(null);
  const [tender, setTender] = useState('');
  const [payModal, setPayModal] = useState(false);

  // ---------- hold / sale record / layby ----------
  const heldRef = useRef([]);
  const [layby, setLayby] = useState(null); // { mode:'create'|'pay' }
  const [store, setStore] = useState(null);
  const printerTypeRef = useRef('80mm'); // from configured default printer
  const [saleRecord, setSaleRecord] = useState(null);

  const hw = usePOSHardware({
    onCommand: (cmd) => {
      switch (cmd) {
        case 'F2': doSave(); break;
        case 'F3': doPrint(); break;
        case 'F4': toggleHold(); break;
        case 'F5': openPayModal(); break;
        case 'Delete': removeSelected(); break;
        case 'Enter': handleEnter(); break;
        case 'Escape': setPayModal(false); setOpenShift(false); setCustAdd(false); break;
        case 'ArrowUp': setSel((s) => (cart.length ? (s <= 0 ? cart.length - 1 : s - 1) : -1)); break;
        case 'ArrowDown': setSel((s) => (cart.length ? (s >= cart.length - 1 ? 0 : s + 1) : -1)); break;
        default: break;
      }
    },
    onScan: handleScan,
  });

  // ---------- loaders ----------
  const refreshShift = useCallback(async () => {
    try { const s = await api.get('/eod/current'); setShift(s.shift || s || null); } catch { setShift(null); }
  }, []);

  const loadCats = useCallback(async () => {
    try {
      const c = await api.get('/categories');
      const list = Array.isArray(c) ? c : c.categories || [];
      setCats(list.length ? list : FALLBACK_DEPTS.map((n, i) => ({ id: null, name: n })));
    } catch { setCats(FALLBACK_DEPTS.map((n, i) => ({ id: null, name: n }))); }
  }, []);

  const loadFast = useCallback(async (catName, query) => {
    const params = new URLSearchParams();
    const cat = cats.find((c) => c.name === catName);
    if (cat?.id != null) params.set('categoryId', cat.id);
    if (query) params.set('search', query);
    try {
      const r = await api.get(`/products${params.toString() ? '?' + params.toString() : ''}`);
      const list = Array.isArray(r) ? r : r.products || [];
      setFastItems(list);
      for (const p of list) productMapRef.current.set(p.id, p);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  }, [cats, toast]);

  const loadCust = useCallback(async (q) => {
    try {
      const r = await api.get(`/customers${q ? '?search=' + encodeURIComponent(q) : '?limit=8'}`);
      setCustResults(Array.isArray(r) ? r : r.customers || []);
    } catch { setCustResults([]); }
  }, []);

  const loadStore = useCallback(async () => {
    try { setStore(await api.get('/settings')); } catch { /* optional */ }
    try {
      const list = await api.get('/printers');
      const def = (Array.isArray(list) ? list : []).find((p) => p.is_default) || null;
      printerTypeRef.current = def?.type || '80mm';
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    refreshShift();
    loadCats();
    loadStore();
  }, [refreshShift, loadCats, loadStore]);

  useEffect(() => { loadFast(activeCat, prodQuery.trim()); }, [activeCat, prodQuery]); // eslint-disable-line
  useEffect(() => { const t = setTimeout(() => loadCust(custQuery), 220); return () => clearTimeout(t); }, [custQuery, loadCust]);

  // ---------- cart math ----------
  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, l) => s + l.unitCents * l.qty, 0);
    const disc = Math.round(subtotal * (discPct / 100));
    const total = subtotal - disc;
    const grandQty = cart.reduce((s, l) => s + l.qty, 0);
    // per-line discount allocation (basis points of gross share)
    const lines = cart.map((l) => {
      const share = subtotal ? l.unitCents * l.qty / subtotal : 0;
      return { ...l, lineDisc: Math.round(disc * share), lineTotal: l.unitCents * l.qty - Math.round(disc * share) };
    });
    return { subtotal, disc, total, grandQty, lines };
  }, [cart, discPct]);

  const tenderCents = Math.max(0, Math.round(Number(tender || 0) * 100) || 0);
  const changeCents = payMethod === 'CASH' && tenderCents > totals.total ? tenderCents - totals.total : 0;

  // ---------- cart ops ----------
  const pickTierPrice = useCallback((p, qty) => {
    if (!saleTier || !p.tiers?.length) return p.price_cents;
    const t = p.tiers.find((t) => t.tier_name === saleTier && qty >= (t.min_qty || 1));
    return t ? t.price_cents : p.price_cents;
  }, [saleTier]);

  const addProduct = useCallback((p, qt = 1) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.productId === p.id);
      productMapRef.current.set(p.id, p);
      const unitCents = pickTierPrice(p, qt);
      if (i >= 0) {
        const n = [...c];
        const merged = { ...n[i], qty: n[i].qty + qt, unitCents: pickTierPrice(n[i].product ?? p, n[i].qty + qt) };
        if (!merged.tierName && saleTier) merged.tierName = saleTier;
        n[i] = merged;
        return n;
      }
      return [...c, {
        key: p.id, productId: p.id, product: p, sku: p.sku || '', barcode: p.barcode || p.sku || '',
        name: p.name, unitCents, qty: qt, bin: '', tierName: saleTier || undefined,
      }];
    });
    setSel(cart.length); // will select the appended row
  }, [cart.length, saleTier, pickTierPrice]);

  const setLineQty = useCallback((idx, qty) => {
    setCart((c) => {
      const n = [...c];
      if (qty <= 0) { n.splice(idx, 1); if (sel >= idx) setSel((s) => Math.max(-1, s - 1)); return n; }
      const line = n[idx];
      const product = line.product || productMapRef.current.get(line.productId);
      n[idx] = { ...line, qty, unitCents: pickTierPrice(product, qty) };
      return n;
    });
  }, [sel, pickTierPrice]);

  const removeLine = useCallback((idx) => {
    setCart((c) => { const n = [...c]; n.splice(idx, 1); return n; });
    setSel((s) => (s >= cart.length - 1 ? cart.length - 2 : s));
  }, [cart.length]);

  const removeSelected = useCallback(() => {
    if (sel >= 0 && sel < cart.length) removeLine(sel);
    else toast.warn('No line selected');
  }, [sel, cart.length, removeLine, toast]);

  const clearCart = useCallback(() => { setCart([]); setSel(-1); setDiscPct(0); setTender(''); setPayMethod(null); setQtyEntry(''); }, []);

  // ---------- keypad ----------
  const pressDigit = (d) => { if (payMethod === 'CASH') setTender((t) => (t + d).replace(/^0+(?=\d)/, '')); else setQtyEntry((e) => (e + d).replace(/^0+(?=\d)/, '')); };
  const pressDot = () => { if (payMethod === 'CASH') setTender((t) => (t.includes('.') ? t : t + '.')); else setQtyEntry((e) => (e.includes('.') ? e : e + '.')); };
  const pressMinus = () => { if (sel >= 0 && sel < cart.length) setLineQty(sel, cart[sel].qty - 1); else toast.warn('No line selected'); };

  const applyQty = () => {
    if (!qtyEntry) { return false; }
    if (sel < 0 || sel >= cart.length) { toast.warn('Select a line first'); return false; }
    let v = parseFloat(qtyEntry);
    if (Number.isNaN(v)) v = 1;
    setLineQty(sel, Math.round(v));
    setQtyEntry('');
    return true;
  };

  const handleEnter = () => {
    if (payModal) { confirmPay(); return; }
    if (applyQty()) return;
    if (cart.length) openPayModal();
  };

  // ---------- scan ----------
  async function handleScan(code) {
    const q = String(code || '').trim();
    if (!q) return;
    try {
      let p = null;
      try { p = await api.get(`/products/by-barcode/${encodeURIComponent(q)}`); } catch { p = null; }
      if (!p?.id) {
        const r = await api.get(`/products/search?q=${encodeURIComponent(q)}`);
        const res = Array.isArray(r) ? r : r.results || [];
        if (res.length === 1) p = res[0];
        else if (res.length > 1) { toast.warn(`${res.length} matches for "${q}"`); return; }
      }
      if (p?.id) { addProduct(p); refreshMeta(p); }
      else toast.warn(`No product for "${q}"`);
    } catch (e) { toast.warn(`No product for "${q}"`); }
  }
  function refreshMeta(p) { productMapRef.current.set(p.id, p); }

  // ---------- shift ----------
  const doOpenShift = async () => {
    try {
      const body = {};
      if (shiftFloat !== '') body.openingCashCents = Math.round(Number(shiftFloat) * 100);
      const s = await api.post('/eod/open', body);
      setShift(s.shift || s || null);
      setOpenShift(false); setShiftFloat('');
      toast.ok('Shift opened');
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  // ---------- payment / sale ----------
  function openPayModal() {
    if (!shift) { toast.warn('Open a shift first'); return; }
    if (!cart.length) { toast.warn('Cart is empty'); return; }
    setPayMethod((m) => m || 'CASH');
    setPayModal(true);
  }

  async function confirmPay(overrides = {}) {
    if (!shift) { toast.warn('Open a shift first'); return; }
    if (!cart.length) { toast.warn('Cart is empty'); return; }
    const method = overrides.method || payMethod;
    let amt = totals.total;
    let tnd = overrides.tenderCents != null ? overrides.tenderCents : tenderCents;
    if (method === 'CASH') {
      if (tnd === 0) tnd = totals.total; // exact tender default
      if (tnd < totals.total) { toast.warn('Tender is less than total'); return; }
      amt = tnd;
    }
    const snapshot = totals.lines;
    try {
      const res = await api.post('/pos/sell', {
        items: cart.map((l) => ({ productId: l.productId, qty: l.qty, tierName: l.tierName || undefined })),
        payments: [{ method, amountCents: amt }],
        customerId: customer?.id,
        orderDiscountPercent: discPct,
      });
      const rec = { order: res, items: snapshot, method, tenderCents: tnd, changeCents: Math.max(0, tnd - totals.total) };
      setSaleRecord(rec);
      clearCart();
      setPayModal(false);
      refreshShift();
      toast.ok(`Sale ${res.doc_no} recorded`);
      try { await printSale(rec); } catch (e) { toast.warn(`Print failed: ${e.message}`); }
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  }

  const doSave = () => confirmPay({ method: payMethod || 'CASH' });

  // ---------- print ----------
  async function printSale(rec) {
    const doc = saleReceiptDoc(rec);
    await hw.print(doc, { type: printerTypeRef.current, builder: (d) => buildPosReceipt(d) });
  }

  function saleReceiptDoc(rec) {
    const meta = JSON.parse(rec.order.meta || '{}');
    const payments = Object.entries(meta.payments || {}).map(([m, c]) => ({ method: PAY_LABELS[m] || m, amountCents: c }));
    const lines = (rec.items || []).map((l) => ({ name: l.name, qty: l.qty, priceCents: l.unitCents, totalCents: l.lineTotal }));
    const printerType = printerTypeRef.current === '58mm' ? '58mm' : '80mm';
    return {
      width: printerType === '58mm' ? 32 : 42, type: printerType,
      company: store?.company || '', address: store?.address || '', phone: store?.phone || '', tin: store?.tin || '',
      title: 'RECEIPT', docNo: rec.order.doc_no,
      date: fmtDT(rec.order.created_at),
      cashier: user?.full_name || user?.username || '—',
      customer: customer?.name,
      lines,
      subtotalCents: rec.order.subtotal_cents, taxCents: rec.order.tax_cents, taxName: store?.taxName || '',
      totalCents: rec.order.total_cents,
      tenderedCents: meta.change != null ? rec.order.total_cents + (meta.change || 0) : undefined,
      changeCents: meta.change || 0,
      payments,
      footer: store?.company || '',
    };
  }

  function laybyVoucherDoc(order, items, deposit) {
    const printerType = printerTypeRef.current === '58mm' ? '58mm' : '80mm';
    return {
      width: printerType === '58mm' ? 32 : 42, type: printerType,
      company: store?.company || '', address: store?.address || '', phone: store?.phone || '', tin: store?.tin || '',
      title: 'LAYBY AGREEMENT', docNo: order.doc_no,
      date: fmtDT(order.created_at), cashier: user?.full_name || user?.username || '—',
      customer: order.customer_name || customer?.name,
      lines: (items || []).map((l) => ({ name: l.name, qty: l.qty, priceCents: l.unitCents, totalCents: l.lineTotal })),
      totalCents: order.total_cents, paidCents: order.paid_cents, balanceCents: order.total_cents - order.paid_cents,
      paymentHistory: (order.meta_payments || []),
      terms: 'Goods held pending full settlement. Balance payable before collection.',
    };
  }

  const doPrint = async () => {
    if (saleRecord) { try { await printSale(saleRecord); toast.ok('Reprinted'); } catch (e) { toast.warn(e.message); } return; }
    toast.warn('No completed sale to print');
  };

  // ---------- hold / recall ----------
  const toggleHold = () => {
    if (cart.length) {
      heldRef.current = [...heldRef.current, { cart, discPct, customer }];
      clearCart();
      setCustomer(null);
      toast.ok(`Sale held (${heldRef.current.length})`);
    } else if (heldRef.current.length) {
      const h = heldRef.current.pop();
      setCart(h.cart); setDiscPct(h.discPct); setCustomer(h.customer);
      toast.ok('Sale recalled');
    } else {
      toast.warn('Nothing to recall');
    }
  };

  // ---------- customer ----------
  const selectCustomer = (c) => { setCustomer(c); setCustQuery(''); setCustResults([]); };

  const saveNewCustomer = async () => {
    if (!custForm.name.trim()) { toast.warn('Name is required'); return; }
    try {
      const { id } = await api.post('/customers', {
        name: custForm.name, phone: custForm.phone, email: custForm.email,
        taxId: custForm.taxId || undefined,
        creditLimitCents: custForm.debtLimit === '' ? undefined : Math.round(Number(custForm.debtLimit) * 100),
      });
      const created = await api.get(`/customers/${id}`);
      selectCustomer(created);
      setCustAdd(false);
      setCustForm({ name: '', phone: '', email: '', taxId: '', debtLimit: '' });
      toast.ok('Customer added');
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  // ---------- open layby ----------
  const openLayby = () => {
    if (!shift) { toast.warn('Open a shift first'); return; }
    if (!cart.length) { toast.warn('Cart is empty'); return; }
    setLayby({ mode: 'create', cart, total: totals.total, discPct });
  };
  const openLaybyPay = () => setLayby({ mode: 'pay', cart: [], total: 0, discPct: 0 });

  // ---------- derived ----------
  const selLine = sel >= 0 && sel < totals.lines.length ? totals.lines[sel] : null;
  const selProduct = selLine ? productMapRef.current.get(selLine.productId) : null;
  const selOnHand = selProduct ? Math.max(0, (selProduct.qty_on_hand || 0) - (selProduct.qty_reserved || 0)) : null;

  const tierOptions = useMemo(() => {
    const names = new Set();
    for (const p of productMapRef.current.values()) for (const t of p.tiers || []) names.add(t.tier_name);
    return [...names].sort();
  }, [fastItems, cart]);

  const catTint = (name) => {
    const idx = cats.findIndex((c) => c.name === name);
    return CAT_TINTS[(idx >= 0 ? idx : 0) % CAT_TINTS.length];
  };

  if (!can('pos.sell')) {
    return <div className="panel"><div className="empty-state">No POS permissions.</div></div>;
  }

  return (
    <div className="cpos">
      {/* ============ TOP LEFT: CART GRID ============ */}
      <section className="cpos-cart">
        <div className="cpos-bar">
          <span className="cpos-title">SALE — ACTIVE LINES</span>
          <span className="cpos-shift">{shift ? `SHIFT ${shift.doc_no}` : 'NO SHIFT'}</span>
        </div>
        <div className="cpos-table-wrap">
          <table className="cpos-table">
            <thead>
              <tr>
                <th className="w-pn">Part No. / Barcode</th>
                <th className="w-desc">Part Details</th>
                <th className="num">Qty</th>
                <th className="num">Amount</th>
                <th className="num">Disc</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {totals.lines.map((l, i) => (
                <tr key={l.productId} className={i === sel ? 'cpos-row-sel' : ''} onClick={() => setSel(i)}>
                  <td className="mono">{l.barcode || l.sku || '—'}</td>
                  <td className="desc">
                    <span className="pname">{l.name}{l.product?.is_bundle || (l.product ? productMapRef.current.get(l.productId)?.is_bundle : false) ? '  [KIT]' : ''}</span>
                    {l.uomName ? <span className="bin">{l.uomName}</span> : null}
                    {l.bin ? <span className="bin">{l.bin}</span> : null}
                  </td>
                  <td className="num mono">{l.qty}</td>
                  <td className="num mono">{fmtMoney(l.unitCents)}</td>
                  <td className="num mono">{fmtMoney(l.lineDisc)}</td>
                  <td className="num mono">{fmtMoney(l.lineTotal)}</td>
                </tr>
              ))}
              {totals.lines.length === 0 && (
                <tr><td colSpan="6" className="cpos-empty">No lines. Scan or tap a fast-key item.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="cpos-status">
          <span>Bin: <b className="mono">{selProduct?.bin_location || '—'}</b></span>
          <span>On-hand: <b className="mono">{selOnHand != null ? selOnHand : '—'}</b></span>
          {selProduct?.batches?.length > 0 && (
            <span title="Nearest-expiry batch (FEFO)">
              FEFO: <b className="mono">
                {(() => {
                  const sorted = [...selProduct.batches].filter((b) => b.expiry_date).sort((a, b) => (a.expiry_date > b.expiry_date ? 1 : -1));
                  return sorted.length ? `${sorted[0].batch_no} ${sorted[0].qty_on_hand} exp ${sorted[0].expiry_date}` : '—';
                })()}
              </b>
            </span>
          )}
          <span>Lines: <b className="mono">{cart.length}</b></span>
          <span>Qty: <b className="mono">{totals.grandQty}</b></span>
          {selLine && selProduct?.uom?.length > 0 && (
            <span className="cpos-uoms">
              Units:
              {selProduct.uom.map((u) => (
                <button key={u.uom_name}
                  className="uom-btn"
                  onClick={() => {
                    if (sel < 0) return;
                    const factor = Number(u.conversion_factor) || 1;
                    setLineQty(sel, Math.round((cart[sel]?.qty || 1) * factor));
                    toast.ok(`${selProduct.name} × ${factor} → ${u.uom_name}`);
                  }}>
                  {u.uom_name} ×{u.conversion_factor}
                </button>
              ))}
            </span>
          )}
          <span className="cpos-status-total">Items: <b>{fmtMoney(totals.subtotal)}</b></span>
        </div>
        <div className="cpos-fnbar">
          <button className="fn fn-save" onClick={doSave}>Save <kbd>F2</kbd></button>
          <button className="fn fn-print" onClick={doPrint}>Print <kbd>F3</kbd></button>
          <button className="fn fn-hold" onClick={toggleHold}>Hold/Recall <kbd>F4</kbd></button>
          <button className="fn fn-pay" onClick={openPayModal}>Pay <kbd>F5</kbd></button>
        </div>
      </section>

      {/* ============ TOP RIGHT: KEYPAD + TOTALS + CUSTOMER ============ */}
      <section className="cpos-right">
        <div className="cpos-kp">
          <div className="cpos-kp-readout mono">{payMethod === 'CASH' ? (tender ? '$' + tender : 'TENDER') : qtyEntry || 'QTY'}</div>
          <div className="cpos-kp-grid">
            <button onClick={() => pressDigit('7')}>7</button>
            <button onClick={() => pressDigit('8')}>8</button>
            <button onClick={() => pressDigit('9')}>9</button>
            <button onClick={() => pressDigit('4')}>4</button>
            <button onClick={() => pressDigit('5')}>5</button>
            <button onClick={() => pressDigit('6')}>6</button>
            <button onClick={() => pressDigit('1')}>1</button>
            <button onClick={() => pressDigit('2')}>2</button>
            <button onClick={() => pressDigit('3')}>3</button>
            <button onClick={() => pressDigit('0')}>0</button>
            <button onClick={pressDot}>.</button>
            <button className="kp-minus" onClick={pressMinus}>−</button>
          </div>
          <div className="cpos-kp-ops">
            <button className="op op-clr" onClick={() => { setQtyEntry(''); setTender(''); }}>Clear</button>
            <button className="op op-x" onClick={removeSelected}>Del&nbsp;Line</button>
            <button className="op op-enter" onClick={handleEnter}>Enter</button>
            <button className="op op-kick" onClick={async () => { try { await hw.openCashDrawer(); } catch { toast.warn('Cash drawer: no serial port'); } }}>Cash Drawer</button>
          </div>
          <div className="cpos-paymethods">
            {Object.keys(PAY_LABELS).map((m) => (
              <button key={m} className={`pm pm-${m.toLowerCase()}${payMethod === m ? ' on' : ''}`}
                onClick={() => { setPayMethod(m); if (m !== 'CASH') setTender(''); }}>
                {PAY_LABELS[m]}
              </button>
            ))}
            <button className="pm pm-layby" onClick={openLayby}>LAYBY</button>
          </div>
        </div>

        <div className="cpos-totals">
          <div className="cpos-total-row t-total"><span>Total</span><b className="mono">{fmtMoney(totals.total)}</b></div>
          <div className="cpos-total-row t-paid"><span>Paid</span><b className="mono">
            {payMethod === 'CASH' ? fmtMoney(Math.max(totals.total, tenderCents ? tenderCents : totals.total)) : payMethod ? fmtMoney(totals.total) : fmtMoney(0)}
          </b></div>
          <div className="cpos-total-row t-chg"><span>Change</span><b className="mono">{fmtMoney(changeCents)}</b></div>
          <div className="cpos-tender">
            <label>Cash Tendered</label>
            <input data-pos-enter="1" className="mono" value={tender} onChange={(e) => setTender(e.target.value)} placeholder="0.00"
              onFocus={() => setPayMethod('CASH')} />
          </div>
          <div className="cpos-disc">
            <label>Discount %</label>
            <input className="mono" type="number" min="0" max="100" value={discPct} onChange={(e) => setDiscPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
          </div>
        </div>

        <div className="cpos-cust">
          <div className="cpos-cust-hd">
            <span>Tier</span>
            <select className="cpos-tier-select" value={saleTier} onChange={(e) => { setSaleTier(e.target.value); toast.ok(e.target.value ? `Tier: ${e.target.value}` : 'Tier: Retail'); }}>
              <option value="">Retail</option>
              {tierOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="cpos-cust-hd">
            <span>Customer</span>
            <button className="btn-link" onClick={() => setCustAdd(true)}>Quick add</button>
            <button className="btn-link" onClick={openLaybyPay}>Pay Layby</button>
          </div>
          {customer ? (
            <div className="cpos-cust-card">
              <div className="cpos-cust-main">
                <span className="avatar">{initials(customer.name)}</span>
                <div className="cpos-cust-meta">
                  <div className="cpos-cust-name">{customer.name}</div>
                  <div className="cpos-cust-sub">{customer.phone || customer.email || 'no contact'}</div>
                </div>
                <button className="btn-link" onClick={() => setCustomer(null)}>×</button>
              </div>
              <div className="cpos-cust-stats">
                <span>Balance <b>{fmtMoney(customer.outstanding_cents ?? 0)}</b></span>
                <span>Points <b>{customer.points ?? customer.loyalty_points ?? 0}</b></span>
                <span>Credit <b>{fmtMoney(customer.credit_limit_cents ?? 0)}</b></span>
              </div>
            </div>
          ) : (
            <div className="cpos-cust-search">
              <input value={custQuery} onChange={(e) => setCustQuery(e.target.value)} placeholder="Search customer… / TIN / phone" />
              {custResults.length > 0 && (
                <div className="cpos-cust-results">
                  {custResults.map((c) => (
                    <button key={c.id} className="cpos-cust-result" onClick={() => selectCustomer(c)}>
                      <span className="mono">{c.name}</span>
                      <span className="mono muted">{fmtMoney(c.outstanding_cents ?? 0)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ============ BOTTOM: DEPARTMENTS + FAST KEYS ============ */}
      <section className="cpos-bottom">
        <div className="cpos-depts">
          {cats.map((c) => {
            const t = catTint(c.name);
            const on = activeCat === c.name;
            return (
              <button key={c.name} className="cpos-dept"
                style={on ? { background: t.hard, color: '#fff', borderColor: t.hard } : { background: t.soft, color: t.hard, borderColor: t.soft }}
                onClick={() => setActiveCat(on ? null : c.name)}>
                {c.name}
              </button>
            );
          })}
          <input className="cpos-prod-search mono" value={prodQuery} onChange={(e) => setProdQuery(e.target.value)} placeholder="search / SKU…" />
        </div>
        <div className="cpos-fast">
          {fastItems.map((p) => (
            <button key={p.id} className="cpos-fastkey" onClick={() => addProduct(p)}>
              <span className="mono fk-name">{p.name}</span>
              <span className="mono fk-price">{fmtMoney(p.price_cents)}</span>
              <span className="mono fk-stock">{(p.qty_on_hand || 0) - (p.qty_reserved || 0)}</span>
            </button>
          ))}
          {fastItems.length === 0 && (
            <div className="cpos-empty2">No products in this department.</div>
          )}
        </div>
      </section>

      {/* ============ SHIFT MODAL ============ */}
      {openShift && (
        <Modal title="Open Shift" onClose={() => setOpenShift(false)}
          footer={<button className="btn btn-primary" onClick={doOpenShift}>Open Shift</button>}>
          <div className="field"><label>Opening cash float</label>
            <input className="mono" value={shiftFloat} onChange={(e) => setShiftFloat(e.target.value)} placeholder="0.00" /></div>
        </Modal>
      )}

      {/* ============ QUICK ADD CUSTOMER ============ */}
      {custAdd && (
        <Modal title="Quick Add Customer" onClose={() => setCustAdd(false)}
          footer={<button className="btn btn-primary" onClick={saveNewCustomer}>Add Customer</button>}>
          <div className="field"><label>Name *</label><input value={custForm.name} onChange={(e) => setCustForm({ ...custForm, name: e.target.value })} /></div>
          <div className="field"><label>Phone</label><input value={custForm.phone} onChange={(e) => setCustForm({ ...custForm, phone: e.target.value })} /></div>
          <div className="field"><label>Email</label><input value={custForm.email} onChange={(e) => setCustForm({ ...custForm, email: e.target.value })} /></div>
          <div className="field"><label>Tax ID / TIN</label><input value={custForm.taxId} onChange={(e) => setCustForm({ ...custForm, taxId: e.target.value })} /></div>
          <div className="field"><label>Debt limit (credit)</label><input className="mono" value={custForm.debtLimit} onChange={(e) => setCustForm({ ...custForm, debtLimit: e.target.value })} placeholder="0.00" /></div>
        </Modal>
      )}

      {/* ============ PAY MODAL (F5) ============ */}
      {payModal && (
        <Modal title="Payment" onClose={() => setPayModal(false)}
          footer={
            <div className="modal-actions">
              <button className="btn" onClick={() => setPayModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmPay}>Charge {fmtMoney(totals.total)}</button>
            </div>
          }>
          <div className="cpos-paymodal">
            <div className="cpos-paytotal mono">{fmtMoney(totals.total)}</div>
            <div className="cpos-paymethods">
              {Object.keys(PAY_LABELS).map((m) => (
                <button key={m} className={`pm pm-${m.toLowerCase()}${payMethod === m ? ' on' : ''}`}
                  onClick={() => { setPayMethod(m); if (m !== 'CASH') setTender(''); }}>{PAY_LABELS[m]}</button>
              ))}
            </div>
            {payMethod === 'CASH' && (
              <div className="cpos-paycash">
                <div className="cpos-total-row t-chg"><span>Change</span><b className="mono">{fmtMoney(changeCents)}</b></div>
                <div className="quick-amt">
                  {[Math.ceil(totals.total / 100) * 100, Math.ceil(totals.total / 100) * 100 + 500, Math.ceil(totals.total / 100) * 100 + 1000].map((a) => (
                    <button key={a} className="btn btn-ghost btn-sm mono" onClick={() => setTender((a / 100).toFixed(2))}>{fmtMoney(a)}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ============ LAYBY MODAL ============ */}
      {layby && (
        <LaybyPaymentModal
          mode={layby.mode}
          cart={layby.cart}
          total={layby.total}
          discPct={layby.discPct}
          customer={customer}
          store={store}
          cashier={user?.full_name || user?.username}
          onClose={() => setLayby(null)}
          onCreated={(order) => {
            setLayby(null);
            clearCart();
            refreshShift();
            toast.ok(`Layby ${order.doc_no} created`);
            try {
              const items = layby.cart;
              hw.print(laybyVoucherDoc(order, items, order.paid_cents), { type: '80mm', builder: (d) => buildLaybyReceipt(d) }).catch(() => {});
            } catch { /* print optional */ }
            loadCust(custQuery);
          }}
          onPaid={(order) => { setLayby(null); toast.ok(`Payment recorded on ${order.doc_no}`); loadCust(custQuery); }}
        />
      )}

      {!shift && (
        <div className="cpos-noshift">
          No open shift — <button className="btn btn-primary btn-sm" onClick={() => setOpenShift(true)}>Open Shift</button> before selling.
        </div>
      )}
    </div>
  );
}