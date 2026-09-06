import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import PrinterPanel from '../components/PrinterPanel';

export default function SettingsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ company: '', address: '', phone: '', tin: '', currency: '$', taxName: 'VAT', termsDays: '30', fiscal: false, cashDrawer: false });

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get('/settings');
        setForm({
          company: s.company || '', address: s.address || '', phone: s.phone || '', tin: s.tin || '',
          currency: s.currency || '$', taxName: s.taxName || 'VAT', termsDays: s.termsDays || '30',
          fiscal: !!s.fiscal, cashDrawer: !!s.cashDrawer,
        });
      } catch (e) { if (e?.silent) return; toast.err(e.message); }
    })();
  }, []);

  const save = async () => {
    try {
      await api.post('/settings', { ...form, termsDays: Number(form.termsDays) || 30 });
      toast.ok('Settings saved');
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  if (!can('settings.manage')) {
    return <div className="panel"><div className="empty-state">Settings are restricted to admin roles.</div></div>;
  }

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title"><h1>Settings</h1><p>Company details and POS behaviour.</p></div>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </div>
      <div className="panel">
        <div className="panel-hd"><span>Company</span></div>
        <div className="form-grid">
          <div className="field"><label>Company name</label><input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></div>
          <div className="field"><label>Address</label><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
          <div className="field"><label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div className="field"><label>TIN</label><input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} /></div>
          <div className="field"><label>Currency</label><input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} /></div>
          <div className="field"><label>Tax name</label><input value={form.taxName} onChange={(e) => setForm({ ...form, taxName: e.target.value })} /></div>
          <div className="field"><label>Default terms (days)</label><input value={form.termsDays} onChange={(e) => setForm({ ...form, termsDays: e.target.value })} /></div>
        </div>
        <div className="checks">
          <label className="check"><input type="checkbox" checked={form.fiscal} onChange={(e) => setForm({ ...form, fiscal: e.target.checked })} /> Fiscal POS mode</label>
          <label className="check"><input type="checkbox" checked={form.cashDrawer} onChange={(e) => setForm({ ...form, cashDrawer: e.target.checked })} /> Open cash drawer on cash sale</label>
        </div>
      </div>
      <PrinterPanel />
    </div>
  );
}
