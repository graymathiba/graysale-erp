import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import DynamicDocumentPrint from '../components/DynamicDocumentPrint';

const EMPTY = {
  company_name: '',
  trading_as: '',
  tagline: '',
  address: '',
  telephone: '',
  mobile: '',
  reg_number: '',
  tin_number: '',
  vat_number: '',
  banking_details: [],
};

const EMPTY_BANK = { bank_name: '', branch: '', account_name: '', usd_account: '', zig_account: '' };

export default function CompanySettingsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get('/company-settings');
        setForm({ ...EMPTY, ...s, banking_details: Array.isArray(s.banking_details) ? s.banking_details : [] });
      } catch (e) { if (e?.silent) return; toast.err(e.message); }
    })();
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const bankChange = (idx, k, v) => {
    const banks = form.banking_details.map((b, i) => (i === idx ? { ...b, [k]: v } : b));
    set('banking_details', banks);
  };

  const addBank = () => set('banking_details', [...form.banking_details, { ...EMPTY_BANK }]);
  const removeBank = (idx) => set('banking_details', form.banking_details.filter((_, i) => i !== idx));

  const save = async () => {
    setLoading(true);
    try {
      await api.put('/company-settings', form);
      toast.ok('Company profile updated.');
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
    finally { setLoading(false); }
  };

  if (!can('settings.manage')) {
    return <div className="page"><div className="panel"><div className="empty-state">Company profile is restricted to admin roles.</div></div></div>;
  }

  const previewData = {
    docType: form.reg_number ? 'QUOTATION' : 'INVOICE',
    docNumber: 'Q-0001',
    date: '01 Jan 2026',
    dueDate: '15 Jan 2026',
    customerName: 'Sample Customer Name',
    items: [
      { description: 'Sample product line item', quantity: 2, rate: 25.0, amount: 50.0 },
      { description: 'Another sample item', quantity: 1, rate: 15.0, amount: 15.0 },
    ],
    totalAmount: 65.0,
  };

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title"><h1>Company Profile</h1><p>Business, statutory tax details &amp; bank accounts printed on invoices and quotations.</p></div>
        <button className="btn btn-primary" onClick={save} disabled={loading}>{loading ? 'Saving…' : 'Save'}</button>
      </div>

      <div className="panel">
        <div className="panel-hd"><span>Business Details</span></div>
        <div className="form-grid">
          <div className="field"><label>Company name</label><input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} /></div>
          <div className="field"><label>Trading as (T/A)</label><input value={form.trading_as} onChange={(e) => set('trading_as', e.target.value)} /></div>
          <div className="field"><label>Tagline</label><input value={form.tagline} onChange={(e) => set('tagline', e.target.value)} /></div>
          <div className="field"><label>Address</label><input value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="field"><label>Telephone</label><input value={form.telephone} onChange={(e) => set('telephone', e.target.value)} /></div>
          <div className="field"><label>Cell / Mobile</label><input value={form.mobile} onChange={(e) => set('mobile', e.target.value)} /></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd"><span>Statutory Tax Details</span></div>
        <div className="form-grid three">
          <div className="field"><label>REG NO</label><input value={form.reg_number} onChange={(e) => set('reg_number', e.target.value)} /></div>
          <div className="field"><label>TIN</label><input value={form.tin_number} onChange={(e) => set('tin_number', e.target.value)} /></div>
          <div className="field"><label>VAT NO</label><input value={form.vat_number} onChange={(e) => set('vat_number', e.target.value)} /></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd">
          <span>Bank Accounts</span>
          <button type="button" className="btn btn-ghost" onClick={addBank}>+ Add Bank Account</button>
        </div>
        <div className="doc-dup">Accounts appear on printed invoices &amp; quotations.</div>
        {form.banking_details.length === 0 && <div className="empty-state">No bank accounts added.</div>}
        {form.banking_details.map((bank, i) => (
          <div className="bank-card" key={i}>
            <button type="button" className="bank-remove" onClick={() => removeBank(i)}>Remove</button>
            <div className="form-grid">
              <div className="field"><label>Bank name</label><input placeholder="e.g. ECOBANK BANK ZIMBABWE" value={bank.bank_name} onChange={(e) => bankChange(i, 'bank_name', e.target.value)} /></div>
              <div className="field"><label>Branch</label><input placeholder="e.g. GWERU BRANCH" value={bank.branch} onChange={(e) => bankChange(i, 'branch', e.target.value)} /></div>
              <div className="field"><label>Account holder name</label><input placeholder="Account holder" value={bank.account_name} onChange={(e) => bankChange(i, 'account_name', e.target.value)} /></div>
              <div className="field"><label>USD account number</label><input value={bank.usd_account} onChange={(e) => bankChange(i, 'usd_account', e.target.value)} /></div>
              <div className="field"><label>ZiG account number</label><input value={bank.zig_account} onChange={(e) => bankChange(i, 'zig_account', e.target.value)} /></div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-hd"><span>Document Preview</span></div>
        <div className="doc-preview">
          <DynamicDocumentPrint companySettings={form} documentData={previewData} />
        </div>
      </div>
    </div>
  );
}
