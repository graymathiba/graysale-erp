import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import DynamicDocumentPrint from '../components/DynamicDocumentPrint';

// Full-page A4 renderer for quotes / sales. Opens the system print dialog
// automatically once the sheet has painted. Mounted outside the desktop
// shell so nothing but the document is printed.
export default function DocumentPrintPage() {
  const { kind, id } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: '' });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [order, cs, settings] = await Promise.all([
          api.get(`/orders/${id}`),
          api.get('/company-settings'),
          api.get('/settings'),
        ]);
        let customerName = '';
        if (order.customer_id) {
          try {
            const c = await api.get(`/customers/${order.customer_id}`);
            customerName = c.name || '';
          } catch {
            /* walk-in is fine */
          }
        }
        const isQuote = order.type === 'QUOTE' || kind === 'quote';
        const created = order.created_at || '';
        const date = created ? created.slice(0, 10) : '';
        let dueDate = '';
        if (isQuote) {
          const days = Number(settings.quoteValidityDays) || 0;
          if (days > 0 && created) {
            const d = new Date(created.replace(' ', 'T'));
            d.setDate(d.getDate() + days);
            dueDate = d.toISOString().slice(0, 10);
          }
        }
        const items = (order.lines || []).map((l) => ({
          description: l.product_name,
          quantity: l.qty,
          rate: (l.unit_price_cents || 0) / 100,
          amount: (l.line_total_cents || 0) / 100,
        }));
        if (!alive) return;
        setState({
          loading: false,
          error: '',
          companySettings: cs,
          documentData: {
            docType: isQuote ? 'QUOTATION' : 'INVOICE',
            docNumber: order.doc_no,
            date,
            dueDate,
            dueLabel: isQuote ? 'Valid Until:' : 'Due:',
            customerName,
            items,
            totalAmount: (order.total_cents || 0) / 100,
            footer: isQuote ? settings.quoteFooter : settings.invoiceFooter,
          },
        });
      } catch (e) {
        if (alive) setState({ loading: false, error: e.message || 'Could not load document' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [kind, id]);

  useEffect(() => {
    if (state.loading || state.error) return undefined;
    // Small beat so fonts/layout settle before the system dialog opens.
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [state.loading, state.error]);

  if (state.loading) {
    return (
      <div className="loader">
        <span className="spinner" />
        Preparing document…
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="doc-print-page">
        <div className="doc-print-bar">
          <button className="btn" onClick={() => navigate(-1)}>
            Back
          </button>
          <span className="doc-print-err">{state.error}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="doc-print-page">
      <div className="doc-print-bar">
        <button className="btn" onClick={() => navigate(-1)}>
          Back
        </button>
        <button className="btn btn-primary" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <DynamicDocumentPrint companySettings={state.companySettings} documentData={state.documentData} />
    </div>
  );
}
