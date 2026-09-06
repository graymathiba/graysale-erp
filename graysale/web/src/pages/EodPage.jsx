import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import DataTable from '../components/DataTable';
import { fmtMoney, fmtDT } from '../lib/format';
import { printReceipt, buildEodReport } from '../lib/thermalPrinter';

export default function EodPage() {
  const { user, can } = useAuth();
  const toast = useToast();

  const [current, setCurrent] = useState(null);
  const [shifts, setShifts] = useState([]);
  const [openShiftModal, setOpenShiftModal] = useState(false);
  const [openingCash, setOpeningCash] = useState('');
  const [report, setReport] = useState(null);       // X report view
  const [zModal, setZModal] = useState(null);        // { shiftId }
  const [counted, setCounted] = useState('');

  const load = useCallback(async () => {
    try {
      const c = await api.get('/eod/current');
      setCurrent(c.shift || c || null);
    } catch { setCurrent(null); }
    try {
      const s = await api.get('/eod/shifts');
      setShifts(Array.isArray(s) ? s : s.shifts || []);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openShift = async () => {
    try {
      const body = {};
      if (openingCash !== '') body.openingCashCents = Math.round(Number(openingCash) * 100);
      const s = await api.post('/eod/open', body);
      setCurrent(s.shift || s || null);
      setOpenShiftModal(false);
      setOpeningCash('');
      toast.ok('Shift opened');
      load();
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  const showX = async (shift) => {
    try {
      const r = await api.get(`/eod/report/${shift.id}`);
      setReport(r);
      // X-report is printable too
      try {
        const doc = reportDoc(r, false);
        await printReceipt(doc, { type: '80mm', builder: (d) => buildEodReport(d, { isZ: false }) });
      } catch { /* optional */ }
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  const doZ = async () => {
    try {
      const r = await api.post(`/eod/report/${zModal.id}/z`, { countedCashCents: Math.round(Number(counted) * 100) || null });
      setZModal(null);
      setCounted('');
      toast.ok(`Z-report ${r.shift?.doc_no} — shift closed`);
      load();
      // print Z report
      try {
        const doc = reportDoc(r, true);
        await printReceipt(doc, { type: '80mm', builder: (d) => buildEodReport(d, { isZ: true }) });
      } catch (e2) { /* non-fatal */ }
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  const columns = [
    { key: 'doc_no', label: 'Shift' },
    { key: 'user', label: 'Cashier', render: (s) => s.full_name || s.username || '—' },
    { key: 'opened_at', label: 'Opened', render: (s) => fmtDT(s.opened_at) },
    { key: 'closed_at', label: 'Closed', render: (s) => s.closed_at ? fmtDT(s.closed_at) : <span className="badge badge-green">OPEN</span> },
    { key: 'opening', label: 'Float', render: (s) => fmtMoney(s.opening_cash_cents) },
    { key: 'tot', label: 'Total', render: (s) => fmtMoney((s.cash_in ?? 0) + (s.cash_out ?? 0)) },
    { key: 'actions', label: 'Actions', render: (s) => (
      <div className="row-actions">
        <button className="btn-link" onClick={() => showX(s)}>X-Report</button>
        {s.status === 'OPEN' && can('eod.run') && (
          <button className="btn-link danger" onClick={() => setZModal({ id: s.id })}>Z (Close)</button>
        )}
      </div>
    ) },
  ];

  const isCurrentMine = current && (can('eod.view') || (current.user_id === user?.id));

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title"><h1>Day Close (EOD)</h1><p>Open your shift and close out with X/Z reports.</p></div>
        <button className="btn btn-primary" onClick={() => setOpenShiftModal(true)} disabled={!!current}>+ Open shift</button>
      </div>

      <div className="eod-banner">
        {current ? (
          <div className="eod-current">
            <div className="ec-dot" />
            <div>
              <div className="ec-title">Shift {current.doc_no} is open</div>
              <div className="ec-sub">Opened {fmtDT(current.opened_at)} · float {fmtMoney(current.opening_cash_cents)}</div>
            </div>
            <button className="btn" onClick={() => showX(current)}>View X-report</button>
          </div>
        ) : (
          <div className="eod-noshift">No open shift. Open one to start selling.</div>
        )}
      </div>

      <DataTable columns={columns} rows={shifts} rowKey={(s) => s.id} empty="No shifts recorded yet."
        caption={<div className="table-capt"><span>Shift history</span></div>} />

      {/* X report modal */}
      {report && (
        <Modal title={`X-Report — ${report.shift?.doc_no}`} onClose={() => setReport(null)}
          footer={<button className="btn btn-primary" onClick={() => setReport(null)}>Close</button>} wide>
          <EodReportView report={report} />
        </Modal>
      )}

      {/* Z modal */}
      {zModal && (
        <Modal title="Close shift (Z-Report)" onClose={() => setZModal(null)}
          footer={
            <div className="modal-actions">
              <button className="btn" onClick={() => setZModal(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={doZ}>Run Z &amp; Close Shift</button>
            </div>
          }>
          <div className="field">
            <label>Counted cash on hand (optional)</label>
            <input value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0.00" autoFocus />
          </div>
          <p className="hint">The Z-report closes the shift, computes variance and posts the end-of-day audit.</p>
        </Modal>
      )}
    </div>
  );
}

function EodReportView({ report }) {
  const b = report.breakdown || {};
  const rows = [
    ['Opening float', report.opening_float_cents],
    ['Cash sales', b.cash], ['Card', b.card], ['Mobile', b.mobile], ['Bank', b.bank],
    b.layby ? ['Layby deposits', b.layby] : null,
    b.cashRefund ? ['Cash refunded', -b.cashRefund] : null,
  ].filter(Boolean);

  return (
    <div className="eod-report">
      <div className="er-hd">
        <div><div className="er-title">{report.shift?.doc_no}</div>
          <div className="muted">Cashier: {report.cashier?.full_name || report.cashier?.username || '—'}</div></div>
        <div className="er-status"><BadgeOpen closed={report.shift?.status === 'CLOSED'} /></div>
      </div>
      <table className="grid">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><td className="lbl">{k}</td><td className="num">{v != null ? fmtMoney(v) : '—'}</td></tr>
          ))}
          <tr className="total-row"><td className="lbl">Sales count</td><td className="num">{report.sale_count ?? 0}</td></tr>
          {report.layby?.count != null && <tr><td className="lbl">Layby count</td><td className="num">{report.layby.count}</td></tr>}
          <tr className="grand-row"><td className="lbl">Expected cash</td><td className="num">{fmtMoney(report.expected_cash_cents)}</td></tr>
          {report.counted_cash_cents != null && (
            <>
              <tr><td className="lbl">Counted cash</td><td className="num">{fmtMoney(report.counted_cash_cents)}</td></tr>
              <tr className="variance"><td className="lbl">Over / Short</td>
                <td className="num">{report.variance_cents >= 0 ? '+' : '−'}{fmtMoney(Math.abs(report.variance_cents))}</td></tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function BadgeOpen({ closed }) {
  return closed ? <span className="badge badge-gray">CLOSED</span> : <span className="badge badge-green">OPEN</span>;
}

function reportDoc(r, isZ) {
  const b = r.breakdown || {};
  return {
    width: 42,
    type: '80mm',
    company: r.company || 'GraySale Store',
    shift: r.shift, cashier: r.cashier,
    opening_float_cents: r.opening_float_cents,
    expected_cash_cents: r.expected_cash_cents,
    counted_cash_cents: r.counted_cash_cents,
    variance_cents: r.variance_cents,
    sale_count: r.sale_count,
    breakdown: b,
    layby: r.layby,
    isZ,
  };
}
