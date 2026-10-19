import Modal from './Modal';
import { fmtMoney } from '../lib/format';

export const PAY_LABELS = { CASH: 'CASH', CARD: 'CARD', MOBILE: 'MOBILE', ECOCASH: 'ECOCASH', BANK: 'BANK' };

export function ShiftModal({ shiftFloat, setShiftFloat, onOpen, onClose }) {
  return (
    <Modal
      title="Open Shift"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onOpen}>
          Open Shift
        </button>
      }
    >
      <div className="field">
        <label>Opening cash float</label>
        <input className="mono" value={shiftFloat} onChange={(e) => setShiftFloat(e.target.value)} placeholder="0.00" />
      </div>
    </Modal>
  );
}

export function QuickAddCustomerModal({ form, setForm, onSave, onClose }) {
  return (
    <Modal
      title="Quick Add Customer"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onSave}>
          Add Customer
        </button>
      }
    >
      <div className="field">
        <label>Name *</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <label>Phone</label>
        <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </div>
      <div className="field">
        <label>Email</label>
        <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      <div className="field">
        <label>Tax ID / TIN</label>
        <input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
      </div>
      <div className="field">
        <label>Debt limit (credit)</label>
        <input
          className="mono"
          value={form.debtLimit}
          onChange={(e) => setForm({ ...form, debtLimit: e.target.value })}
          placeholder="0.00"
        />
      </div>
    </Modal>
  );
}

export function PayModal({
  total,
  tender,
  setTender,
  changeCents,
  payMethod,
  setPayMethod,
  setQtyTarget,
  ecoPhone,
  setEcoPhone,
  onCharge,
  onClose,
}) {
  const isCash = payMethod === 'CASH';
  const received = Math.round(Number(tender || 0) * 100) || 0;
  const stillDue = isCash && received > 0 && received < total ? total - received : 0;
  const quickAmounts = [
    Math.ceil(total / 100) * 100,
    Math.ceil(total / 100) * 100 + 500,
    Math.ceil(total / 100) * 100 + 1000,
  ].filter((a, i, arr) => a > total && arr.indexOf(a) === i);

  const pick = (m) => {
    setPayMethod(m);
    if (m !== 'CASH') setTender('');
    setQtyTarget(m === 'CASH' ? 'tender' : 'qty');
  };

  return (
    <Modal
      title="Payment"
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onCharge}>
            {payMethod === 'ECOCASH' ? `Prompt *151# ${fmtMoney(total)}` : `Charge ${fmtMoney(total)}`}
          </button>
        </div>
      }
    >
      <div className="cpos-paymodal">
        <div className="cpos-paytotal mono">{fmtMoney(total)}</div>
        <div className="cpos-paymethods">
          {Object.keys(PAY_LABELS).map((m) => (
            <button
              key={m}
              className={`pm pm-${m.toLowerCase()}${payMethod === m ? ' on' : ''}`}
              onClick={() => pick(m)}
            >
              {PAY_LABELS[m]}
            </button>
          ))}
        </div>

        {isCash && (
          <div className="cpos-paycash">
            <div className="field">
              <label>Cash received</label>
              <input
                className="mono cpos-tender-input"
                data-pos-enter="1"
                value={tender}
                onChange={(e) => setTender(e.target.value)}
                placeholder="0.00"
                autoComplete="off"
                autoFocus
              />
            </div>
            <div className="quick-amt">
              <button className="btn btn-ghost btn-sm mono" onClick={() => setTender((total / 100).toFixed(2))}>
                Exact {fmtMoney(total)}
              </button>
              {quickAmounts.map((a) => (
                <button key={a} className="btn btn-ghost btn-sm mono" onClick={() => setTender((a / 100).toFixed(2))}>
                  {fmtMoney(a)}
                </button>
              ))}
            </div>
            <div className="cpos-total-row t-chg">
              <span>Change</span>
              <b className="mono">{fmtMoney(changeCents)}</b>
            </div>
            {stillDue > 0 && <p className="hint mt-2">Still due: {fmtMoney(stillDue)}</p>}
            {!received && <p className="hint mt-2">Leave blank to take the exact amount.</p>}
          </div>
        )}

        {!isCash && payMethod !== 'ECOCASH' && (
          <div className="cpos-paycash">
            <div className="cpos-total-row t-total">
              <span>Amount due</span>
              <b className="mono">{fmtMoney(total)}</b>
            </div>
            <p className="hint mt-2">No cash to take. Collect the card / transfer first, then press Charge.</p>
          </div>
        )}

        {payMethod === 'ECOCASH' && (
          <div className="cpos-paycash">
            <div className="field">
              <label>Customer EcoCash phone</label>
              <input
                className="mono"
                value={ecoPhone}
                onChange={(e) => setEcoPhone(e.target.value)}
                placeholder="e.g. 0771234567"
                autoComplete="off"
                autoFocus
              />
            </div>
            <p className="hint mt-2">
              The customer confirms on their phone. The sale settles only when EcoCash confirms the money.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function EcoWaitingModal({ ecoSale, total, onCancel, onClose }) {
  return (
    <Modal
      title="EcoCash Payment"
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={ecoSale.done}>
            Cancel sale
          </button>
        </div>
      }
    >
      <div className="cpos-eco">
        <div className="cpos-eco-amt mono">{fmtMoney(ecoSale.order?.total_cents ?? total)}</div>
        {ecoSale.done && ecoSale.order?.status === 'PAID' && (
          <div className="cpos-eco-status ok">Payment received — {ecoSale.order.doc_no}</div>
        )}
        {ecoSale.done && ecoSale.order?.status === 'VOID' && (
          <div className="cpos-eco-status err">{ecoSale.order.ecocash_status || 'Payment failed'}</div>
        )}
        {!ecoSale.done &&
          (ecoSale.order ? (
            <div className="cpos-eco-wait">
              <p className="hint">
                Ask the customer to dial <b>*151#</b> and confirm the EcoCash payment with reference
                <b className="mono"> {ecoSale.ref}</b>.
              </p>
              <div className="cpos-eco-status waiting">
                <span className="spinner" /> Waiting for customer to pay…
              </div>
              <div className="cpos-eco-ref mono">Ref {ecoSale.ref}</div>
            </div>
          ) : (
            <p className="hint">Starting EcoCash payment…</p>
          ))}
      </div>
    </Modal>
  );
}

// Several products matched the typed code — let the cashier tap the right one
// instead of dropping the sale.
export function PickProductModal({ query, options, onPick, onClose }) {
  return (
    <Modal title={`Which product?`} onClose={onClose}>
      <p className="hint mb-2">More than one product matches “{query}”.</p>
      <div className="cpos-picklist">
        {options.map((p) => (
          <button key={p.id} className="cpos-pickrow" onClick={() => onPick(p)}>
            <span className="pick-name">{p.name}</span>
            <span className="mono muted">
              {p.sku || ''}
              {p.barcode ? ` · ${p.barcode}` : ''}
            </span>
            <span className="mono">{fmtMoney(p.price_cents)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// Scanned a barcode that is not in the catalog yet. Managers can create the
// product right here with two fields; no trip to the Stock page.
export function QuickAddProductModal({ code, name, price, setName, setPrice, saving, onSave, onClose }) {
  return (
    <Modal
      title="Add new product"
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Adding…' : 'Add to sale'}
          </button>
        </div>
      }
    >
      <p className="hint mb-2">“{code}” is not in the catalog yet. Give it a name and price to sell it now.</p>
      <div className="field">
        <label>Product name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 5m Fishing Line" autoFocus />
      </div>
      <div className="field">
        <label>Selling price</label>
        <input className="mono" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
      </div>
    </Modal>
  );
}
