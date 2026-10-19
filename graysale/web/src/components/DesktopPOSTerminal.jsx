import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import {
  ShiftModal,
  QuickAddCustomerModal,
  PayModal,
  EcoWaitingModal,
  PickProductModal,
  QuickAddProductModal,
  PAY_LABELS,
} from './ClassicPOSModals';
import usePOSHardware from '../hooks/usePOSHardware';
import usePOSCart from '../hooks/usePOSCart';
import { computeTotals } from '../lib/posTotals';
import LaybyPaymentModal from './LaybyPaymentModal';
import DesktopIcon from './DesktopIcons';
import { buildPosReceipt, buildLaybyReceipt } from '../lib/thermalPrinter';
import { friendlyPosError } from '../lib/posErrors';
import { fmtMoney, fmtDT, initials } from '../lib/format';
import '../styles/pos-terminal.css';
import '../styles/desktop-pos.css';

// Two-tone department tints (grey / violet), Retail Man flavour.
const CAT_TINTS = [
  { soft: '#e2e8f0', hard: '#334155' },
  { soft: '#ede9fe', hard: '#6d28d9' },
];
const FALLBACK_DEPTS = ['Hardware', 'Keys', 'Fishing', 'Ammo', 'General'];

export default function DesktopPOSTerminal() {
  const { user, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // ---------- shift ----------
  const [shift, setShift] = useState(null);
  const [openShift, setOpenShift] = useState(false);
  const [shiftFloat, setShiftFloat] = useState('');

  // ---------- catalogue ----------
  const [cats, setCats] = useState([]);
  const [activeCat, setActiveCat] = useState(null); // category name or null=All
  const [fastItems, setFastItems] = useState([]);
  const [fastStatus, setFastStatus] = useState('loading'); // loading | ready | error
  const [prodQuery, setProdQuery] = useState('');

  // ---------- cart / tender / keypad ----------
  const {
    cart,
    setCart,
    sel,
    setSel,
    discPct,
    setDiscPct,
    qtyEntry,
    setQtyEntry,
    payMethod,
    setPayMethod,
    tender,
    setTender,
    keyTarget,
    setKeyTarget,
    productMapRef,
    addProduct,
    removeSelected,
    clearCart,
    pressDigit,
    pressDot,
    pressMinus,
    applyQty,
  } = usePOSCart();

  // Tax-aware totals mirroring the server (the modern screen's hook predates
  // per-line tax, so this terminal computes its own).
  const totals = useMemo(
    () => computeTotals(cart, discPct, productMapRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cart, discPct],
  );
  const tenderCents = Math.max(0, Math.round(Number(tender || 0) * 100) || 0);
  const changeCents = payMethod === 'CASH' && tenderCents > totals.total ? tenderCents - totals.total : 0;

  // ---------- customer ----------
  const [customer, setCustomer] = useState(null);
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState([]);
  const [custAdd, setCustAdd] = useState(false);
  const [custForm, setCustForm] = useState({ name: '', phone: '', email: '', taxId: '', debtLimit: '' });

  // ---------- payment ----------
  const [payModal, setPayModal] = useState(false);
  const [ecoPhone, setEcoPhone] = useState('');
  const [ecoSale, setEcoSale] = useState(null);
  const [pickList, setPickList] = useState(null);
  const [quickAdd, setQuickAdd] = useState(null);
  const [quickAddSaving, setQuickAddSaving] = useState(false);

  const closePayModal = () => {
    setPayModal(false);
    setKeyTarget('qty');
  };

  // ---------- hold / sale record / layby ----------
  const heldRef = useRef([]);
  const [layby, setLayby] = useState(null); // { mode:'create'|'pay' }
  const [store, setStore] = useState(null);
  const printerTypeRef = useRef('80mm');
  const [saleRecord, setSaleRecord] = useState(null);

  const hw = usePOSHardware({
    onCommand: (cmd) => {
      switch (cmd) {
        case 'F2':
        case 'F5':
          openPayModal();
          break;
        case 'F3':
          doPrint();
          break;
        case 'F4':
          toggleHold();
          break;
        case 'Delete':
          removeSelected();
          break;
        case 'Enter':
          handleEnter();
          break;
        case 'Escape':
          closePayModal();
          setPickList(null);
          setQuickAdd(null);
          setOpenShift(false);
          setCustAdd(false);
          break;
        case 'ArrowUp':
          setSel((s) => (cart.length ? (s <= 0 ? cart.length - 1 : s - 1) : -1));
          break;
        case 'ArrowDown':
          setSel((s) => (cart.length ? (s >= cart.length - 1 ? 0 : s + 1) : -1));
          break;
        default:
          break;
      }
    },
    onScan: handleScan,
  });

  // ---------- loaders ----------
  const refreshShift = useCallback(async () => {
    try {
      const s = await api.get('/eod/current');
      setShift(s.shift || s || null);
    } catch {
      setShift(null);
    }
  }, []);

  const loadCats = useCallback(async () => {
    try {
      const c = await api.get('/categories');
      const list = Array.isArray(c) ? c : c.categories || [];
      // A store with no departments simply shows no department buttons.
      setCats(list);
    } catch {
      setCats(FALLBACK_DEPTS.map((n) => ({ id: null, name: n })));
    }
  }, []);

  const loadFast = useCallback(
    async (catName, query) => {
      const params = new URLSearchParams();
      const cat = cats.find((c) => c.name === catName);
      if (cat?.id != null) params.set('categoryId', cat.id);
      if (query) params.set('search', query);
      try {
        const r = await api.get(`/products${params.toString() ? '?' + params.toString() : ''}`);
        const list = Array.isArray(r) ? r : r.products || [];
        setFastItems(list);
        setFastStatus('ready');
        for (const p of list) productMapRef.current.set(p.id, p);
      } catch (e) {
        setFastItems([]);
        setFastStatus('error');
        if (e?.silent) return; // interceptor owns the toast/redirect
        toast.err(e.message);
      }
    },
    [cats, toast, productMapRef],
  );

  const loadCust = useCallback(async (q) => {
    try {
      const r = await api.get(`/customers${q ? '?search=' + encodeURIComponent(q) : '?limit=8'}`);
      setCustResults(Array.isArray(r) ? r : r.customers || []);
    } catch {
      setCustResults([]);
    }
  }, []);

  const loadStore = useCallback(async () => {
    try {
      setStore(await api.get('/settings'));
    } catch {
      /* optional */
    }
    try {
      const list = await api.get('/printers');
      const def = (Array.isArray(list) ? list : []).find((p) => p.is_default) || null;
      printerTypeRef.current = def?.type || '80mm';
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    refreshShift();
    loadCats();
    loadStore();
  }, [refreshShift, loadCats, loadStore]);

  useEffect(() => {
    const q = prodQuery.trim();
    const t = setTimeout(() => loadFast(activeCat, q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [activeCat, prodQuery, loadFast]);
  useEffect(() => {
    const t = setTimeout(() => loadCust(custQuery), 220);
    return () => clearTimeout(t);
  }, [custQuery, loadCust]);

  // ---------- enter ----------
  const handleEnter = () => {
    if (pickList || quickAdd) return;
    if (payModal) {
      if (payMethod === 'ECOCASH') {
        startEcoPay();
        return;
      }
      confirmPay();
      return;
    }
    if (applyQty()) return;
    if (cart.length) openPayModal();
  };

  // ---------- scan ----------
  async function handleScan(code) {
    const q = String(code || '').trim();
    if (!q) return;
    try {
      let p = null;
      try {
        p = await api.get(`/products/by-barcode/${encodeURIComponent(q)}`);
      } catch {
        p = null;
      }
      if (!p?.id) {
        const r = await api.get(`/products/search?q=${encodeURIComponent(q)}`);
        const res = Array.isArray(r) ? r : r.results || [];
        if (res.length === 1) p = res[0];
        else if (res.length > 1) {
          setPickList({ query: q, options: res.slice(0, 8) });
          return;
        }
      }
      if (p?.id) {
        addProduct(p);
        refreshMeta(p);
      } else {
        toast.warn(friendlyPosError(`PRODUCT_NOT_FOUND: ${q}`));
        if (can('catalog.manage')) setQuickAdd({ code: q, name: '', price: '' });
      }
    } catch (e) {
      toast.warn(friendlyPosError(`PRODUCT_NOT_FOUND: ${q}`));
    }
  }

  // Enter in the scan box: look the term up, or fall through to the
  // cart's own Enter (qty apply / open Pay) when the box is empty.
  const submitScan = () => {
    const q = prodQuery.trim();
    if (!q) {
      handleEnter();
      return;
    }
    setProdQuery('');
    handleScan(q);
  };

  const saveQuickAdd = async () => {
    const code = quickAdd?.code || '';
    const name = String(quickAdd?.name || '').trim();
    const priceCents = Math.round(Number(quickAdd?.price || 0) * 100);
    if (!name) {
      toast.warn('Enter a product name');
      return;
    }
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      toast.warn('Enter a selling price');
      return;
    }
    setQuickAddSaving(true);
    try {
      const res = await api.post('/products', {
        name,
        sku: `SKU-${code}`,
        barcode: /^\d+$/.test(code) ? code : '',
        priceCents,
        costCents: 0,
      });
      const created = res?.product || {
        id: res?.id,
        name,
        sku: `SKU-${code}`,
        barcode: code,
        price_cents: priceCents,
        tiers: [],
      };
      created.price_cents = priceCents;
      created.tiers = created.tiers || [];
      addProduct(created);
      refreshMeta(created);
      setQuickAdd(null);
      toast.ok(`${name} added to the catalog`);
    } catch (e) {
      if (!e?.silent) toast.err(friendlyPosError(e.message));
    } finally {
      setQuickAddSaving(false);
    }
  };
  function refreshMeta(p) {
    productMapRef.current.set(p.id, p);
  }

  // Global search / barcode wedge routes here as /desktop/pos?q=<code>.
  useEffect(() => {
    const q = searchParams.get('q');
    if (!q) return;
    handleScan(q);
    navigate('/desktop/pos', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, navigate]);

  // ---------- shift ----------
  const doOpenShift = async () => {
    try {
      const body = {};
      if (shiftFloat !== '') body.openingCashCents = Math.round(Number(shiftFloat) * 100);
      const s = await api.post('/eod/open', body);
      setShift(s.shift || s || null);
      setOpenShift(false);
      setShiftFloat('');
      toast.ok('Shift opened');
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  // ---------- payment / sale ----------
  function openPayModal() {
    if (pickList || quickAdd) return;
    if (!shift) {
      toast.warn('Open a shift first');
      return;
    }
    if (!cart.length) {
      toast.warn('Cart is empty');
      return;
    }
    setPayMethod((m) => m || 'CASH');
    setKeyTarget('tender');
    setPayModal(true);
  }

  async function confirmPay(overrides = {}) {
    if (!shift) {
      toast.warn('Open a shift first');
      return;
    }
    if (!cart.length) {
      toast.warn('Cart is empty');
      return;
    }
    const method = overrides.method || payMethod;
    let amt = totals.total;
    let tnd = overrides.tenderCents != null ? overrides.tenderCents : tenderCents;
    if (method === 'CASH') {
      if (tnd === 0) tnd = totals.total; // exact tender default
      if (tnd < totals.total) {
        toast.warn(friendlyPosError(`UNPAID: need ${totals.total - tnd} cents more`));
        return;
      }
      amt = tnd;
    }
    const snapshot = totals.lines;
    try {
      const res = await api.post('/pos/sell', {
        items: cart.map((l) => ({ productId: l.productId, qty: l.qty })),
        payments: [{ method, amountCents: amt }],
        customerId: customer?.id,
        orderDiscountPercent: discPct,
      });
      const rec = {
        order: res,
        items: snapshot,
        method,
        tenderCents: tnd,
        changeCents: Math.max(0, tnd - totals.total),
      };
      setSaleRecord(rec);
      clearCart();
      closePayModal();
      refreshShift();
      toast.ok(`Sale ${res.doc_no} recorded`);
      try {
        await printSale(rec);
      } catch (e) {
        toast.warn(`Print failed: ${e.message}`);
      }
    } catch (e) {
      if (e?.silent) return;
      toast.err(friendlyPosError(e.message));
    }
  }

  const doSave = () => openPayModal();

  // ---------- EcoCash C2B (two-phase) ----------
  async function startEcoPay() {
    if (!shift) {
      toast.warn('Open a shift first');
      return;
    }
    if (!cart.length) {
      toast.warn('Cart is empty');
      return;
    }
    const phone = String(ecoPhone || '')
      .trim()
      .replace(/\s+/g, '');
    if (phone.replace(/\D/g, '').length < 7) {
      toast.warn('Enter a valid EcoCash phone number');
      return;
    }
    const snapshot = totals.lines;
    closePayModal();
    setEcoSale({ phone, snapshot, order: null, ref: '', done: false });
    try {
      const res = await api.post('/pos/ecocash/initiate', {
        items: cart.map((l) => ({ productId: l.productId, qty: l.qty })),
        payments: [{ method: 'ECOCASH', amountCents: totals.total }],
        phone,
        customerId: customer?.id,
        orderDiscountPercent: discPct,
      });
      setEcoSale((e) => ({ ...e, order: res, ref: res.eco?.reference || '', done: res.status !== 'AWAITING_PAYMENT' }));
    } catch (err) {
      setEcoSale(null);
      if (err?.silent) return;
      toast.err(friendlyPosError(err.message));
    }
  }

  async function cancelEcoSale() {
    const o = ecoSale?.order;
    if (!o) {
      setEcoSale(null);
      return;
    }
    try {
      await api.post('/pos/ecocash/cancel', { orderId: o.id });
      setEcoSale(null);
      refreshShift();
      toast.ok('EcoCash sale cancelled — stock released');
    } catch (err) {
      if (err?.silent) return;
      toast.err(friendlyPosError(err.message));
    }
  }

  useEffect(() => {
    if (!ecoSale?.order || ecoSale?.done) return;
    const id = ecoSale.order.id;
    const snapshot = ecoSale.snapshot;
    let stopped = false;
    const tick = async () => {
      try {
        const o = await api.get(`/pos/ecocash/status/${id}`);
        if (stopped) return;
        setEcoSale((e) => (e && e.order?.id === id ? { ...e, order: o, done: o.status !== 'AWAITING_PAYMENT' } : e));
        if (o.status === 'PAID') {
          const rec = { order: o, items: snapshot, method: 'ECOCASH', tenderCents: 0, changeCents: 0 };
          setSaleRecord(rec);
          clearCart();
          refreshShift();
          toast.ok(`Sale ${o.doc_no} settled via EcoCash`);
          try {
            await printSale(rec);
          } catch (e) {
            toast.warn(`Print failed: ${e.message}`);
          }
        } else if (o.status === 'VOID') {
          toast.err(o.ecocash_status ? `EcoCash payment failed — ${o.ecocash_status}` : 'EcoCash payment failed');
        }
      } catch (e) {
        /* transient — keep polling */
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ecoSale?.order?.id, ecoSale?.done]);

  // ---------- print ----------
  async function printSale(rec) {
    const doc = saleReceiptDoc(rec);
    await hw.print(doc, { type: printerTypeRef.current, builder: (d) => buildPosReceipt(d) });
  }

  function saleReceiptDoc(rec) {
    const meta = JSON.parse(rec.order.meta || '{}');
    const payments = Object.entries(meta.payments || {}).map(([m, c]) => ({
      method: PAY_LABELS[m] || m,
      amountCents: c,
    }));
    const lines = (rec.items || []).map((l) => ({
      name: l.name,
      qty: l.qty,
      priceCents: l.unitCents,
      totalCents: l.lineTotal,
    }));
    const printerType = printerTypeRef.current === '58mm' ? '58mm' : '80mm';
    return {
      width: printerType === '58mm' ? 32 : 42,
      type: printerType,
      company: store?.company || '',
      address: store?.address || '',
      phone: store?.phone || '',
      tin: store?.tin || '',
      title: 'RECEIPT',
      docNo: rec.order.doc_no,
      date: fmtDT(rec.order.created_at),
      cashier: user?.full_name || user?.username || '—',
      customer: customer?.name,
      lines,
      subtotalCents: rec.order.subtotal_cents,
      taxCents: rec.order.tax_cents,
      taxName: store?.taxName || '',
      totalCents: rec.order.total_cents,
      tenderedCents: meta.change != null ? rec.order.total_cents + (meta.change || 0) : undefined,
      changeCents: meta.change || 0,
      payments,
      fiscal: {
        receiptNo: rec.order.fiscal_receipt_no || undefined,
        serial: rec.order.fiscal_serial || undefined,
        receiptId: rec.order.fiscal_receipt_id || undefined,
        hash: rec.order.fiscal_hash || undefined,
      },
      footer: store?.company || '',
    };
  }

  function laybyVoucherDoc(order, items) {
    const printerType = printerTypeRef.current === '58mm' ? '58mm' : '80mm';
    return {
      width: printerType === '58mm' ? 32 : 42,
      type: printerType,
      company: store?.company || '',
      address: store?.address || '',
      phone: store?.phone || '',
      tin: store?.tin || '',
      title: 'LAYBY AGREEMENT',
      docNo: order.doc_no,
      date: fmtDT(order.created_at),
      cashier: user?.full_name || user?.username || '—',
      customer: order.customer_name || customer?.name,
      lines: (items || []).map((l) => ({ name: l.name, qty: l.qty, priceCents: l.unitCents, totalCents: l.lineTotal })),
      totalCents: order.total_cents,
      paidCents: order.paid_cents,
      balanceCents: order.total_cents - order.paid_cents,
      paymentHistory: order.meta_payments || [],
      terms: 'Goods held pending full settlement. Balance payable before collection.',
    };
  }

  const doPrint = async () => {
    if (saleRecord) {
      try {
        await printSale(saleRecord);
        toast.ok('Reprinted');
      } catch (e) {
        toast.warn(e.message);
      }
      return;
    }
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
      setCart(h.cart);
      setDiscPct(h.discPct);
      setCustomer(h.customer);
      toast.ok('Sale recalled');
    } else {
      toast.warn('Nothing to recall');
    }
  };

  // ---------- customer ----------
  const selectCustomer = (c) => {
    setCustomer(c);
    setCustQuery('');
    setCustResults([]);
  };

  const saveNewCustomer = async () => {
    if (!custForm.name.trim()) {
      toast.warn('Name is required');
      return;
    }
    try {
      const { id } = await api.post('/customers', {
        name: custForm.name,
        phone: custForm.phone,
        email: custForm.email,
        taxId: custForm.taxId || undefined,
        creditLimitCents: custForm.debtLimit === '' ? undefined : Math.round(Number(custForm.debtLimit) * 100),
      });
      const created = await api.get(`/customers/${id}`);
      selectCustomer(created);
      setCustAdd(false);
      setCustForm({ name: '', phone: '', email: '', taxId: '', debtLimit: '' });
      toast.ok('Customer added');
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  // ---------- layby ----------
  const openLayby = () => {
    if (!shift) {
      toast.warn('Open a shift first');
      return;
    }
    if (!cart.length) {
      toast.warn('Cart is empty');
      return;
    }
    setLayby({ mode: 'create', cart, total: totals.total, discPct });
  };
  const openLaybyPay = () => setLayby({ mode: 'pay', cart: [], total: 0, discPct: 0 });

  // ---------- derived ----------
  const selLine = sel >= 0 && sel < totals.lines.length ? totals.lines[sel] : null;
  const selProduct = selLine ? productMapRef.current.get(selLine.productId) : null;
  const selOnHand = selProduct ? Math.max(0, (selProduct.qty_on_hand || 0) - (selProduct.qty_reserved || 0)) : null;

  const catTint = (name) => {
    const idx = cats.findIndex((c) => c.name === name);
    return CAT_TINTS[(idx >= 0 ? idx : 0) % CAT_TINTS.length];
  };

  if (!can('pos.sell')) {
    return (
      <div className="panel">
        <div className="empty-state">No POS permissions.</div>
      </div>
    );
  }

  return (
    <div className="dskpos-wrap">
      <div className="dskpos">
        {/* ============ LEFT: CUSTOMER + CART ============ */}
        <section className="dskpos-left">
          <div className="dskpos-cust">
            <span className="lbl">Customer</span>
            {customer ? (
              <div className="dskpos-cust-card">
                <span className="avatar">{initials(customer.name)}</span>
                <div>
                  <div className="dskpos-cust-name">{customer.name}</div>
                  <div className="dskpos-cust-sub">{customer.phone || customer.email || 'no contact'}</div>
                </div>
                <button className="btn-link" onClick={() => setCustomer(null)}>
                  ×
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={custQuery}
                  onChange={(e) => setCustQuery(e.target.value)}
                  placeholder="Search customer… / TIN / phone"
                />
                {custResults.length > 0 && (
                  <div className="dskpos-cust-results">
                    {custResults.map((c) => (
                      <button key={c.id} onClick={() => selectCustomer(c)}>
                        <span className="mono">{c.name}</span>
                        <span className="mono muted">{fmtMoney(c.outstanding_cents ?? 0)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <button className="btn-link" onClick={() => setCustAdd(true)}>
              Quick add
            </button>
            <button className="btn-link" onClick={openLaybyPay}>
              Pay Layby
            </button>
            {customer ? (
              <div className="dskpos-cust-stats">
                <span>
                  Balance <b>{fmtMoney(customer.outstanding_cents ?? 0)}</b>
                </span>
                <span>
                  Points <b>{customer.points ?? customer.loyalty_points ?? 0}</b>
                </span>
              </div>
            ) : null}
          </div>

          {/* scan / manual search — the primary item-entry field */}
          <div className="dskpos-scan">
            <input
              className="mono"
              value={prodQuery}
              onChange={(e) => setProdQuery(e.target.value)}
              placeholder="scan barcode or type item name / SKU — Enter to add"
              aria-label="Scan or search item"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitScan();
              }}
            />
          </div>

          <div className="dskpos-tablewrap">
            <table className="dskpos-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num col-qty">Qty</th>
                  <th className="num col-amt">Amount $</th>
                  <th className="num col-disc">Disc. $</th>
                  <th className="num col-tax">TAX</th>
                  <th className="num col-tot">Total $</th>
                </tr>
              </thead>
              <tbody>
                {totals.lines.map((l, i) => (
                  <tr key={l.productId} className={i === sel ? 'sel' : ''} onClick={() => setSel(i)}>
                    <td>
                      <span className="pname">{l.name}</span>
                      <span className="bin mono"> {l.barcode || l.sku || ''}</span>
                    </td>
                    <td className="num mono col-qty">{l.qty}</td>
                    <td className="num mono col-amt">{fmtMoney(l.gross)}</td>
                    <td className="num mono col-disc">{fmtMoney(l.disc)}</td>
                    <td className="num mono col-tax">{fmtMoney(l.tax)}</td>
                    <td className="num mono col-tot">{fmtMoney(l.lineTotal)}</td>
                  </tr>
                ))}
                {totals.lines.length === 0 && (
                  <tr>
                    <td colSpan="6" className="dskpos-empty">
                      No lines. Scan or search above, or tap a product tile below.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td className="lbl">Summary</td>
                  <td className="num mono col-qty">{totals.grandQty}</td>
                  <td className="num mono col-amt">{fmtMoney(totals.subtotal)}</td>
                  <td className="num mono col-disc">{fmtMoney(totals.discount)}</td>
                  <td className="num mono col-tax">{fmtMoney(totals.tax)}</td>
                  <td className="num mono col-tot">{fmtMoney(totals.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="dskpos-status">
            <span>
              Bin: <b className="mono">{selProduct?.bin_location || '—'}</b>
            </span>
            <span>
              On-hand: <b className="mono">{selOnHand != null ? selOnHand : '—'}</b>
            </span>
            <span>
              Shift: <b className="mono">{shift ? shift.doc_no : 'NONE'}</b>
            </span>
            <span>
              Lines: <b className="mono">{cart.length}</b>
            </span>
            <span>
              Qty: <b className="mono">{totals.grandQty}</b>
            </span>
            <span>
              Items: <b className="mono">{fmtMoney(totals.subtotal)}</b>
            </span>
          </div>

          <div className="dskpos-fnbar">
            <button className="fn" onClick={doSave}>
              Pay <kbd>F2</kbd>
            </button>
            <button className="fn" onClick={doPrint}>
              Print <kbd>F3</kbd>
            </button>
            <button className="fn" onClick={toggleHold}>
              Hold/Recall <kbd>F4</kbd>
            </button>
            <button className="fn" onClick={openLayby}>
              Layby
            </button>
          </div>
        </section>

        {/* ============ RIGHT: KEYPAD + FIN BOX ============ */}
        <aside className="dskpos-right">
          <div className="dskpos-kp">
            <div className={`dskpos-kp-readout mono${keyTarget === 'tender' ? ' kp-tender' : ''}`}>
              {keyTarget === 'tender'
                ? tender
                  ? 'TENDER $' + tender
                  : 'TENDER _'
                : qtyEntry
                  ? 'QTY ' + qtyEntry
                  : 'QTY _'}
            </div>
            <div className="dskpos-kp-ops">
              <button
                className="op-clr"
                onClick={() => {
                  setQtyEntry('');
                  setTender('');
                }}
              >
                Clr
              </button>
              <button className="op-x" onClick={removeSelected}>
                Del
              </button>
              <button className="op-enter" onClick={handleEnter}>
                Enter
              </button>
            </div>
            <div className="dskpos-kp-grid">
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
              <button className="kp-minus" onClick={pressMinus}>
                −
              </button>
            </div>
            <button className="dskpos-save" onClick={doSave} title="Save sale (F2)">
              <DesktopIcon name="floppy" size={22} />
              Save <small>(F2)</small>
            </button>
          </div>

          <div className="dskpos-fin">
            <div className="dskpos-disc">
              <label>Discount %</label>
              <input
                className="mono"
                type="number"
                min="0"
                max="100"
                aria-label="Discount %"
                value={discPct}
                onChange={(e) => setDiscPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              />
            </div>
            <div className="dskpos-fin-row f-total">
              <span>Total</span>
              <b className="mono">{fmtMoney(totals.total)}</b>
            </div>
            <div className="dskpos-fin-row f-paid">
              <span>Paid</span>
              <b className="mono">
                {payModal ? fmtMoney(payMethod === 'CASH' ? tenderCents || totals.total : totals.total) : fmtMoney(0)}
              </b>
            </div>
            <div className="dskpos-fin-row f-chg">
              <span>Change</span>
              <b className="mono">{fmtMoney(changeCents)}</b>
            </div>
          </div>
        </aside>

        {/* ============ BOTTOM: DEPARTMENTS + FAST KEYS ============ */}
        <section className="dskpos-bottom">
          <div className="dskpos-cats">
            <button
              className={`dskpos-cat cat-all${!activeCat && !prodQuery ? ' on' : ''}`}
              onClick={() => {
                setActiveCat(null);
                setProdQuery('');
              }}
            >
              All Menus
            </button>
            {cats.map((c) => {
              const t = catTint(c.name);
              const on = activeCat === c.name;
              return (
                <button
                  key={c.name}
                  className={`dskpos-cat${on ? ' on' : ''}`}
                  style={on ? {} : { background: t.soft, color: t.hard, borderColor: t.soft }}
                  onClick={() => setActiveCat(on ? null : c.name)}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
          <div className="dskpos-fast">
            {fastItems.map((p) => (
              <button key={p.id} className="dskpos-fastkey" onClick={() => addProduct(p)}>
                <span className="mono fk-name">{p.name}</span>
                <span className="mono fk-price">{fmtMoney(p.price_cents)}</span>
                <span className="mono fk-stock">{(p.qty_on_hand || 0) - (p.qty_reserved || 0)}</span>
              </button>
            ))}
            {fastStatus === 'error' ? (
              <div className="dskpos-empty2 dskpos-fasterr" role="alert">
                Products could not be loaded.
                <button className="dskpos-retry" onClick={() => loadFast(activeCat, prodQuery.trim())}>
                  Retry
                </button>
              </div>
            ) : fastItems.length === 0 && fastStatus === 'ready' ? (
              <div className="dskpos-empty2">No products in this department.</div>
            ) : null}
          </div>
        </section>
      </div>

      {/* ============ MODALS ============ */}
      {openShift && (
        <ShiftModal
          shiftFloat={shiftFloat}
          setShiftFloat={setShiftFloat}
          onOpen={doOpenShift}
          onClose={() => setOpenShift(false)}
        />
      )}
      {custAdd && (
        <QuickAddCustomerModal
          form={custForm}
          setForm={setCustForm}
          onSave={saveNewCustomer}
          onClose={() => setCustAdd(false)}
        />
      )}
      {payModal && (
        <PayModal
          total={totals.total}
          tender={tender}
          setTender={setTender}
          changeCents={changeCents}
          payMethod={payMethod}
          setPayMethod={setPayMethod}
          setQtyTarget={setKeyTarget}
          ecoPhone={ecoPhone}
          setEcoPhone={setEcoPhone}
          onCharge={() => {
            if (payMethod === 'ECOCASH') startEcoPay();
            else confirmPay();
          }}
          onClose={closePayModal}
        />
      )}
      {pickList && (
        <PickProductModal
          query={pickList.query}
          options={pickList.options}
          onPick={(p) => {
            addProduct(p);
            refreshMeta(p);
            setPickList(null);
          }}
          onClose={() => setPickList(null)}
        />
      )}
      {quickAdd && (
        <QuickAddProductModal
          code={quickAdd.code}
          name={quickAdd.name}
          price={quickAdd.price}
          setName={(v) => setQuickAdd((q) => ({ ...q, name: v }))}
          setPrice={(v) => setQuickAdd((q) => ({ ...q, price: v }))}
          saving={quickAddSaving}
          onSave={saveQuickAdd}
          onClose={() => setQuickAdd(null)}
        />
      )}
      {ecoSale && (
        <EcoWaitingModal
          ecoSale={ecoSale}
          total={totals.total}
          onCancel={cancelEcoSale}
          onClose={ecoSale.done ? () => setEcoSale(null) : undefined}
        />
      )}
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
              hw.print(laybyVoucherDoc(order, items), {
                type: '80mm',
                builder: (d) => buildLaybyReceipt(d),
              }).catch(() => {});
            } catch {
              /* print optional */
            }
            loadCust(custQuery);
          }}
          onPaid={(order) => {
            setLayby(null);
            toast.ok(`Payment recorded on ${order.doc_no}`);
            loadCust(custQuery);
          }}
        />
      )}

      {!shift && (
        <div className="dskpos-noshift">
          No open shift —{' '}
          <button className="btn btn-primary btn-sm" onClick={() => setOpenShift(true)}>
            Open Shift
          </button>{' '}
          before selling.
        </div>
      )}
    </div>
  );
}
