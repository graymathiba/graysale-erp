import { useEffect, useState } from 'react';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import DataTable, { Badge } from '../components/DataTable';
import { fmtMoney, fmtDT } from '../lib/format';

export default function InvoicesPage() {
  const toast = useToast();
  const [ar, setAr] = useState([]);
  const [ap, setAp] = useState([]);
  const [tab, setTab] = useState('AR');

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/ar');
        setAr(Array.isArray(r) ? r : r.rows || []);
      } catch (e) {
        // Silent (session-expiry) errors are already surfaced by the client
        // interceptor; keep going so the AP tab still loads.
        if (!e?.silent) toast.err(e.message);
      }
      try {
        const r = await api.get('/ap');
        setAp(Array.isArray(r) ? r : r.rows || []);
      } catch (e) {
        /* maybe no cap */
      }
    })();
  }, []);

  const arCols = [
    {
      key: 'doc_no',
      label: 'Ref',
      render: (r) => (
        <div className="cd">
          <div className="cd-txt">
            <div className="cd-nm">{r.doc_no}</div>
            <div className="cd-sub">{r.customer_name || ''}</div>
          </div>
        </div>
      ),
    },
    { key: 'kind', label: 'Kind', render: (r) => <Badge status={r.kind} /> },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'due', label: 'Due', render: (r) => fmtDT(r.due_date) },
    { key: 'total', label: 'Total', num: true, render: (r) => fmtMoney(r.total_cents) },
    { key: 'paid', label: 'Paid', num: true, render: (r) => fmtMoney(r.paid_cents) },
    { key: 'open', label: 'Open', num: true, render: (r) => fmtMoney(r.total_cents - r.paid_cents) },
  ];

  const apCols = [
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
    { key: 'due', label: 'Due', render: (r) => fmtDT(r.due_date) },
    { key: 'total', label: 'Total', num: true, render: (r) => fmtMoney(r.total_cents) },
    { key: 'paid', label: 'Paid', num: true, render: (r) => fmtMoney(r.paid_cents) },
    { key: 'open', label: 'Open', num: true, render: (r) => fmtMoney(r.total_cents - r.paid_cents) },
  ];

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Invoicing / Quotes</h1>
          <p>Accounts receivable &amp; payable.</p>
        </div>
      </div>
      <div className="seg">
        <button className={tab === 'AR' ? 'seg-on' : ''} onClick={() => setTab('AR')}>
          Accounts Receivable (AR)
        </button>
        <button className={tab === 'AP' ? 'seg-on' : ''} onClick={() => setTab('AP')}>
          Accounts Payable (AP)
        </button>
      </div>
      {tab === 'AR' ? (
        <DataTable
          columns={arCols}
          rows={ar}
          rowKey={(r) => r.id}
          empty="No AR invoices."
          caption={
            <div className="table-capt">
              <span>Receivables</span>
            </div>
          }
        />
      ) : (
        <DataTable
          columns={apCols}
          rows={ap}
          rowKey={(r) => r.id}
          empty="No AP invoices."
          caption={
            <div className="table-capt">
              <span>Payables</span>
            </div>
          }
        />
      )}
    </div>
  );
}
