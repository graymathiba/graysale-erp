import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import DataTable, { Badge } from '../components/DataTable';
import { fmtMoney, fmtDT } from '../lib/format';

export default function PurchasingPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);

  const load = async () => {
    try {
      const r = await api.get('/purchase-orders');
      setRows(Array.isArray(r) ? r : r.rows || []);
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const show = async (r) => {
    try {
      setDetail(await api.get(`/purchase-orders/${r.id}`));
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const place = async (r) => {
    try {
      await api.post(`/purchase-orders/${r.id}/place`);
      toast.ok('PO placed');
      load();
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const cols = [
    {
      key: 'doc_no',
      label: 'Ref',
      render: (r) => (
        <div className="cd">
          <div className="cd-txt">
            <div className="cd-nm">{r.doc_no}</div>
            <div className="cd-sub">{r.supplier_name || ''}</div>
          </div>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'date', label: 'Date', render: (r) => fmtDT(r.created_at) },
    { key: 'total', label: 'Total', num: true, render: (r) => fmtMoney(r.total_cents) },
    {
      key: 'a',
      label: '',
      render: (r) => (
        <div className="row-actions">
          <button className="btn-link" onClick={() => show(r)}>
            View
          </button>
          {r.status === 'DRAFT' && can('purchasing.manage') && (
            <button className="btn-link" onClick={() => place(r)}>
              Place
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Purchasing</h1>
          <p>Purchase orders and goods receipts.</p>
        </div>
        <button className="btn btn-primary" disabled={!can('purchasing.manage')}>
          + New purchase order
        </button>
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        empty="No purchase orders."
        caption={
          <div className="table-capt">
            <span>Purchase orders</span>
          </div>
        }
      />

      {detail && (
        <Modal
          title={`${detail.doc_no} — ${detail.supplier_name || ''}`}
          onClose={() => setDetail(null)}
          wide
          footer={
            <button className="btn btn-primary" onClick={() => setDetail(null)}>
              Close
            </button>
          }
        >
          <table className="grid">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {(detail.lines || []).map((l, i) => (
                <tr key={i}>
                  <td>{l.product_name}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{fmtMoney(l.unit_price_cents)}</td>
                  <td className="num">{fmtMoney(l.line_total_cents)}</td>
                </tr>
              ))}
              {!detail.lines?.length && (
                <tr>
                  <td colSpan="4" className="empty-state">
                    No lines.
                  </td>
                </tr>
              )}
              <tr className="grand-row">
                <td colSpan="3" className="lbl">
                  Total
                </td>
                <td className="num">{fmtMoney(detail.total_cents)}</td>
              </tr>
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
