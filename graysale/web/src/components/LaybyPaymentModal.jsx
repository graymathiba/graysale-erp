import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';
import { fmtMoney, fmtDT, fmtDateFull, initials } from '../lib/format';

/**
 * LaybyPaymentModal — two duties:
 *  - mode="create": attach a customer, take a deposit, create a layby from the
 *    active cart. Stock is reserved server-side; balance is recorded against
 *    the customer's outstanding debt.
 *  - mode="pay": find a customer, list open laybys, apply a balance payment.
 *
 * @param {object} props
 *  mode, cart, total, discPct, customer, store, cashier, onClose,
 *  onCreated(order), onPaid(order)
 */
export default function LaybyPaymentModal({ mode, cart, total, discPct, customer, onClose, onCreated, onPaid }) {
  const toast = useToast();

  const [selCust, setSelCust] = useState(customer || null);
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newCust, setNewCust] = useState({ name: '', phone: '', debtLimit: '' });

  const [deposit, setDeposit] = useState('');
  const [layways, setLayways] = useState([]);
  const [selLayby, setSelLayby] = useState(null);
  const [payAmt, setPayAmt] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCust = useCallback(async (q) => {
    try {
      const r = await api.get(`/customers${q ? '?search=' + encodeURIComponent(q) : '?limit=8'}`);
      setCustResults(Array.isArray(r) ? r : r.customers || []);
    } catch { setCustResults([]); }
  }, []);

  useEffect(() => { loadCust(custQuery); }, [custQuery, loadCust]);

  const pickCustomer = async (c) => {
    setSelCust(c);
    setCustResults([]);
    setCustQuery('');
    if (mode === 'pay') {
      try {
        const r = await api.get(`/customers/${c.id}/layaways`);
        const list = Array.isArray(r) ? r : r.rows || [];
        setLayways(list.filter((l) => l.status === 'OPEN'));
      } catch { setLayways([]); }
    }
  };

  const saveNew = async () => {
    if (!newCust.name.trim()) { toast.warn('Name required'); return; }
    try {
      const { id } = await api.post('/customers', {
        name: newCust.name, phone: newCust.phone,
        creditLimitCents: newCust.debtLimit === '' ? undefined : Math.round(Number(newCust.debtLimit) * 100),
      });
      const created = await api.get(`/customers/${id}`);
      setSelCust(created);
      setAdding(false);
      setNewCust({ name: '', phone: '', debtLimit: '' });
      toast.ok('Customer added');
      if (mode === 'pay') { const r = await api.get(`/customers/${id}/layaways`); setLayways((Array.isArray(r) ? r : r.rows || []).filter((l) => l.status === 'OPEN')); }
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  const depositCents = Math.max(0, Math.round(Number(deposit) * 100) || 0);
  const payAmtCents = Math.max(0, Math.round(Number(payAmt) * 100) || 0);

  const validateCreate = () => {
    if (!selCust) { toast.warn('Attach a customer to a layby'); return false; }
    if (!cart || !cart.length) { toast.warn('Cart is empty'); return false; }
    if (depositCents <= 0) { toast.warn('Enter a deposit'); return false; }
    if (depositCents >= total) { toast.warn('Deposit must be less than the total'); return false; }
    return true;
  };

  const create = async () => {
    if (!validateCreate()) return;
    setBusy(true);
    try {
      const order = await api.post('/pos/layaway', {
        items: cart.map((l) => ({ productId: l.productId, qty: l.qty })),
        customerId: selCust.id,
        deposit: depositCents,
        discountPercent: discPct || 0,
      });
      onCreated?.(order);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
    finally { setBusy(false); }
  };

  const validatePay = () => {
    if (!selLayby) { toast.warn('Select an open layby'); return false; }
    if (payAmtCents <= 0) { toast.warn('Enter a payment amount'); return false; }
    if (payAmtCents > selLayby.balance_cents) { toast.warn('Payment exceeds the layby balance'); return false; }
    return true;
  };

  const pay = async () => {
    if (!validatePay()) return;
    setBusy(true);
    try {
      const order = await api.post(`/pos/layaway/${selLayby.id}/pay`, {
        payments: [{ method: 'CASH', amountCents: payAmtCents }],
      });
      onPaid?.(order);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
    finally { setBusy(false); }
  };

  const balance = total - depositCents;

  return (
    <Modal title={mode === 'create' ? 'Layby / Layaway — New Agreement' : 'Pay Layby Balance'} onClose={onClose}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}
            onClick={mode === 'create' ? create : pay}>
            {busy ? 'Working…' : mode === 'create' ? `Create Layby (deposit ${fmtMoney(depositCents)})` : `Apply ${fmtMoney(payAmtCents)}`}
          </button>
        </div>
      } wide>
      <div className="layby-modal">
        {/* customer attach */}
        <div className="layby-cust">
          <div className="layby-hd">Customer</div>
          {selCust ? (
            <div className="cpos-cust-card">
              <span className="avatar">{initials(selCust.name)}</span>
              <div className="cpos-cust-meta">
                <div className="cpos-cust-name">{selCust.name}</div>
                <div className="cpos-cust-sub">{selCust.phone || 'no contact'} · balance {fmtMoney(selCust.outstanding_cents ?? 0)}</div>
              </div>
              <button className="btn-link" onClick={() => { setSelCust(null); setLayways([]); setSelLayby(null); }}>×</button>
            </div>
          ) : (
            <>
              <input value={custQuery} onChange={(e) => setCustQuery(e.target.value)} placeholder="Search customer by name / phone / TIN…" />
              {custResults.length > 0 && (
                <div className="cpos-cust-results">
                  {custResults.map((c) => (
                    <button key={c.id} className="cpos-cust-result" onClick={() => pickCustomer(c)}>
                      <span className="mono">{c.name}</span>
                      <span className="mono muted">{c.phone || '—'}</span>
                    </button>
                  ))}
                </div>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setAdding((a) => !a)}>{adding ? 'Hide quick add' : '+ Quick add customer'}</button>
              {adding && (
                <div className="layby-cust-new">
                  <div className="field"><label>Name *</label><input value={newCust.name} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} /></div>
                  <div className="field"><label>Phone</label><input value={newCust.phone} onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} /></div>
                  <div className="field"><label>Debt limit</label><input className="mono" value={newCust.debtLimit} onChange={(e) => setNewCust({ ...newCust, debtLimit: e.target.value })} placeholder="0.00" /></div>
                  <button className="btn btn-primary btn-sm" onClick={saveNew}>Add customer</button>
                </div>
              )}
            </>
          )}
        </div>

        {mode === 'create' ? (
          /* -------- deposit calc -------- */
          <div className="layby-deposit">
            <div className="layby-hd">Deposit &amp; Balance</div>
            <div className="layby-line mono"><span>Full price</span><b>{fmtMoney(total)}</b></div>
            <div className="field"><label>Deposit (CASH)</label>
              <input className="mono" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="0.00" autoFocus /></div>
            <div className="layby-line mono layby-bal"><span>Balance due</span><b>{fmtMoney(balance)}</b></div>
            <p className="hint">Stock is reserved now. The remaining balance is recorded against the customer's outstanding debt and settles in store before collection.</p>
            <div className="layby-sum">
              <span>{cart?.length || 0} lines</span>
              <span>Customer balance will show {fmtMoney((selCust?.outstanding_cents ?? 0) + balance)}</span>
            </div>
          </div>
        ) : (
          /* -------- pay existing laybys -------- */
          <div className="layby-pay">
            <div className="layby-hd">Open Laybys — {selCust?.name || ''}</div>
            <div className="layby-list">
              {layways.map((l) => (
                <button key={l.id} className={`layby-item ${selLayby?.id === l.id ? 'on' : ''}`} onClick={() => { setSelLayby(l); setPayAmt(''); }}>
                  <span className="mono">{l.doc_no}</span>
                  <span className="mono muted">{fmtDT(l.created_at)}</span>
                  <span className="num mono">due {fmtMoney(l.balance_cents)}</span>
                </button>
              ))}
              {layways.length === 0 && <div className="empty-state">No open laybys for this customer.</div>}
            </div>
            {selLayby && (
              <div className="layby-payamt">
                <div className="layby-line mono"><span>Outstanding</span><b>{fmtMoney(selLayby.balance_cents)}</b></div>
                <div className="field"><label>Payment amount (CASH)</label>
                  <input className="mono" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} placeholder="0.00" autoFocus /></div>
                <div className="layby-line mono layby-bal"><span>Remaining after</span><b>{fmtMoney((selLayby.balance_cents || 0) - payAmtCents)}</b></div>
              </div>
            )}
          </div>
        )}

        {/* activity trail (create-mode shows deposit history of existing laybys) */}
        {mode === 'create' && selCust && (
          <div className="layby-activity">
            <div className="layby-hd">Payment History</div>
            <table className="grid">
              <thead><tr><th>Date</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {selCust._layby_history?.length ? selCust._layby_history.map((h, i) => (
                  <tr key={i}><td>{fmtDateFull(h.date)}</td><td className="num mono">{fmtMoney(h.amount_cents)}</td><td className="num mono">{fmtMoney(h.balance_cents)}</td></tr>
                )) : <tr><td colSpan="3" className="empty-state">No prior payments.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}