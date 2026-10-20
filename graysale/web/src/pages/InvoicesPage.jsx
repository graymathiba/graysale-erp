import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import DataTable, { Badge } from '../components/DataTable';
import { fmtMoney, fmtDT } from '../lib/format';

export default function InvoicesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [ar, setAr] = useState([]);
  const [ap, setAp] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [quotesLoaded, setQuotesLoaded] = useState(false);
  const [tab, setTab] = useState('AR');

  const loadQuotes = async () => {
    try {
      const r = await api.get('/orders?type=QUOTE');
      setQuotes(Array.isArray(r) ? r : r.rows || []);
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setQuotesLoaded(true);
    }
  };

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

  // Quotes are only fetched when the tab is opened — the AR/AP tabs stay the
  // fast path for day-to-day receivables work.
  useEffect(() => {
    if (tab === 'QUOTE' && !quotesLoaded) loadQuotes();
  }, [tab]);

  const convertQuote = async (q) => {
    if (!window.confirm(`Convert ${q.doc_no} to a sale and take full payment (CASH)?`)) return;
    try {
      const res = await api.post(`/pos/quote/${q.id}/convert`, {
        payments: [{ method: 'CASH', amountCents: q.total_cents }],
      });
      toast.ok(`Converted to sale ${res?.doc_no || ''}`);
      loadQuotes();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    }
  };

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

  const quoteCols = [
    {
      key: 'doc_no',
      label: 'Quotation',
      render: (r) => (
        <div className="cd">
          <div className="cd-txt">
            <div className="cd-nm">{r.doc_no}</div>
            <div className="cd-sub">{r.customer_name || 'Walk-in'}</div>
          </div>
        </div>
      ),
    },
    { key: 'created', label: 'Date', render: (r) => fmtDT(r.created_at) },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'total', label: 'Total', num: true, render: (r) => fmtMoney(r.total_cents) },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => navigate(`/print/doc/quote/${r.id}`)}>
            Print A4
          </button>
          {r.status === 'OPEN' && (
            <button className="btn btn-sm btn-primary" onClick={() => convertQuote(r)}>
              Convert
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
          <h1>Invoicing / Quotes</h1>
          <p>Receivables, payables and customer quotations.</p>
        </div>
      </div>
      <div className="seg">
        <button className={tab === 'AR' ? 'seg-on' : ''} onClick={() => setTab('AR')}>
          Accounts Receivable (AR)
        </button>
        <button className={tab === 'AP' ? 'seg-on' : ''} onClick={() => setTab('AP')}>
          Accounts Payable (AP)
        </button>
        <button className={tab === 'QUOTE' ? 'seg-on' : ''} onClick={() => setTab('QUOTE')}>
          Quotes
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
      ) : tab === 'AP' ? (
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
      ) : (
        <DataTable
          columns={quoteCols}
          rows={quotes}
          rowKey={(r) => r.id}
          empty="No quotations yet — create one from the POS (Quote)."
          caption={
            <div className="table-capt">
              <span>Quotations</span>
              <button className="btn btn-sm" onClick={loadQuotes}>
                Refresh
              </button>
            </div>
          }
        />
      )}
    </div>
  );
}
