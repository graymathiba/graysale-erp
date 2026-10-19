import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { fmtMoney } from '../lib/format';

export default function AccountingPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [tb, setTb] = useState(null);
  const [pl, setPl] = useState(null);
  const [verify, setVerify] = useState(null);

  useEffect(() => {
    if (!can('accounting.view')) return;
    (async () => {
      try {
        setTb(await api.get('/accounting/trial-balance'));
      } catch (e) {
        if (e?.silent) return;
        toast.err(e.message);
      }
      try {
        setPl(await api.get('/accounting/pl'));
      } catch (e) {
        /* */
      }
      try {
        setVerify(await api.get('/accounting/verify'));
      } catch (e) {
        /* */
      }
    })();
  }, []);

  if (!can('accounting.view')) {
    return (
      <div className="panel">
        <div className="empty-state">Accounting is restricted to finance roles.</div>
      </div>
    );
  }

  const rows = tb?.rows || tb?.lines || tb?.accounts || [];
  const plRows = pl?.rows || pl?.lines || [];

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Accounting</h1>
          <p>Trial balance, profit &amp; loss, and books health.</p>
        </div>
      </div>

      {verify && (
        <div className={verify.ok ? 'alert alert-ok' : 'alert alert-warn'}>
          {verify.ok
            ? 'Books are in balance'
            : `Books out of balance: ${verify.message || verify.error || 'check detail'}`}
        </div>
      )}

      <div className="two-col">
        <div className="panel">
          <div className="panel-hd">
            <span>Trial balance</span>
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.account_no || r.code || r.account}>
                  <td>{r.account_name || r.account || r.code}</td>
                  <td className="num">{r.debit_cents ? fmtMoney(r.debit_cents) : '—'}</td>
                  <td className="num">{r.credit_cents ? fmtMoney(r.credit_cents) : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan="3" className="empty-state">
                    No data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span>Profit &amp; Loss</span>
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {plRows.map((r, i) => (
                <tr key={i}>
                  <td>{r.label || r.name || r.account || '—'}</td>
                  <td className="num">{fmtMoney(r.amount_cents ?? r.balance_cents ?? 0)}</td>
                </tr>
              ))}
              {plRows.length === 0 && (
                <tr>
                  <td colSpan="2" className="empty-state">
                    No data.
                  </td>
                </tr>
              )}
              {pl?.net_cents != null && (
                <tr className="grand-row">
                  <td className="lbl">Net profit</td>
                  <td className="num">{fmtMoney(pl.net_cents)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
