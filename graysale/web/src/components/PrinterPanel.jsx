import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import { printReceipt } from '../lib/thermalPrinter';

const TYPES = ['80mm', '58mm', 'A4', 'Generic'];
const CONNECTIONS = ['USB', 'Bluetooth', 'Network', 'Serial'];

const EMPTY_FORM = {
  name: '',
  type: '80mm',
  connection: 'USB',
  ipAddress: '',
  cashDrawer: false,
  fiscal: false,
  isDefault: false,
};

export default function PrinterPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const [printers, setPrinters] = useState([]);
  const [settings, setSettings] = useState({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(null); // { id } or {} for new
  const [testing, setTesting] = useState(false);
  const [devicePrinters, setDevicePrinters] = useState(null);
  const [scanning, setScanning] = useState(false);

  const load = async () => {
    try {
      const list = await api.get('/printers');
      setPrinters(Array.isArray(list) ? list : []);
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  useEffect(() => {
    load();
    api
      .get('/settings')
      .then(setSettings)
      .catch(() => {});
  }, []);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setCreating({});
  };

  const openEdit = (p) => {
    setForm({
      name: p.name,
      type: p.type || '80mm',
      connection: p.connection || 'USB',
      ipAddress: p.ip_address || '',
      cashDrawer: !!p.cash_drawer,
      fiscal: !!p.fiscal,
      isDefault: !!p.is_default,
    });
    setCreating({ id: p.id });
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.warn('Printer name is required');
      return;
    }
    const body = {
      name: form.name.trim(),
      type: form.type,
      connection: form.connection,
      ipAddress: form.ipAddress.trim() || null,
      cashDrawer: form.cashDrawer,
      fiscal: form.fiscal,
      isDefault: form.isDefault,
    };
    try {
      if (creating?.id) await api.put(`/printers/${creating.id}`, body);
      else await api.post('/printers', body);
      toast.ok(creating?.id ? 'Printer updated' : 'Printer added');
      setCreating(null);
      load();
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const setDefault = async (p) => {
    try {
      await api.put(`/printers/${p.id}`, { isDefault: true });
      toast.ok(`${p.name} set as default`);
      load();
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete printer "${p.name}"?`)) return;
    try {
      await api.del(`/printers/${p.id}`);
      toast.ok('Printer deleted');
      load();
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  // Test receipt printed through the engine's auto-transport:
  // Web Serial/USB on compatible browsers, window.print() elsewhere.
  const test = async (p) => {
    setTesting(p.id);
    try {
      const is58 = p.type === '58mm';
      const doc = {
        width: is58 ? 32 : 42,
        company: settings.company || 'STORE',
        address: settings.address || '',
        phone: settings.phone || '',
        tin: settings.tin || '',
        title: 'TEST RECEIPT',
        docNo: 'TEST' + String(p.id).padStart(4, '0'),
        date: new Date().toLocaleString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
        cashier: 'Printer test',
        lines: [{ name: 'Sample item', qty: 1, priceCents: 1250, totalCents: 1250 }],
        subtotalCents: 1250,
        taxCents: 0,
        totalCents: 1250,
        payments: [{ method: 'CASH', amountCents: 1250 }],
        tenderedCents: 1250,
        changeCents: 0,
        footer: settings.company || 'Thank you',
      };
      const result = await printReceipt(doc, { type: p.type || '80mm' });
      if (result.transport === 'window') {
        toast.ok('Opened print dialog — pick your receipt printer');
      } else {
        toast.ok(`Sent to printer (${result.transport})`);
      }
    } catch (e) {
      toast.warn(`Test print failed: ${e.message}`);
    } finally {
      setTesting(null);
    }
  };

  const connBadge = (c) => {
    const map = { USB: 'badge-sky', Bluetooth: 'badge-violet', Network: 'badge-amber', Serial: 'badge-gray' };
    return map[c] || 'badge-gray';
  };

  // ----- device printer discovery (wired USB / Bluetooth / network) -----
  // The bundled server runs on this PC, so it can ask Windows for every
  // installed printer. One click adds a discovered device to the ERP.
  const scanDevices = async () => {
    setScanning(true);
    try {
      const rows = await api.get('/printers/system');
      setDevicePrinters(Array.isArray(rows) ? rows : []);
      if (!rows.length) toast.warn('No printers found on this device');
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setScanning(false);
    }
  };

  const guessType = (name = '') => {
    const n = name.toLowerCase();
    if (n.includes('58')) return '58mm';
    if (n.includes('a4') || n.includes('laser') || n.includes('officejet')) return 'A4';
    return '80mm';
  };

  const addDetected = async (d) => {
    try {
      await api.post('/printers', {
        name: d.name,
        type: guessType(d.name),
        connection: d.connection,
        ipAddress: d.connection === 'Network' ? String(d.port || '').replace(/^IP_/, '') : null,
        cashDrawer: false,
        fiscal: false,
        isDefault: printers.length === 0,
      });
      toast.ok(`${d.name} added`);
      load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    }
  };

  return (
    <div className="panel mt-4">
      <div className="panel-hd">
        <span>Receipt printers</span>
        {can('settings.manage') && (
          <button className="btn btn-sm btn-primary" onClick={openNew}>
            + Add printer
          </button>
        )}
      </div>
      <div className="panel-bd">
        <p className="hint">
          Configure the thermal printers used at the till. Receipts print via Web Serial / Web USB where available,
          otherwise through your device&rsquo;s print dialog (works from phones and tablets too).
        </p>

        {can('settings.manage') && (
          <div className="printer-scan">
            <div className="printer-scan-hd">
              <div>
                <div className="printer-scan-title">Printers on this device</div>
                <div className="cd-sub">Wired (USB), Bluetooth and network printers installed on this PC.</div>
              </div>
              <button className="btn btn-sm" onClick={scanDevices} disabled={scanning}>
                {scanning ? 'Scanning…' : 'Scan this PC'}
              </button>
            </div>
            {devicePrinters !== null && (
              <div className="printer-scan-list">
                {devicePrinters.length === 0 ? (
                  <div className="hint">No printers were found. Add one manually below.</div>
                ) : (
                  devicePrinters.map((d) => {
                    const already = printers.some((p) => p.name === d.name);
                    return (
                      <div className="printer-scan-row" key={d.name}>
                        <div className="pc-name">{d.name}</div>
                        <span className={`badge ${connBadge(d.connection)}`}>{d.connection}</span>
                        <span className="cd-sub">
                          {d.port}
                          {d.driver ? ` · ${d.driver}` : ''}
                        </span>
                        <button className="btn btn-sm btn-primary" disabled={already} onClick={() => addDetected(d)}>
                          {already ? 'Added' : 'Add'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {printers.length === 0 ? (
          <div className="empty-state">
            <div className="icon">🖨️</div>
            No printers configured yet.
          </div>
        ) : (
          <div className="printer-grid">
            {printers.map((p) => (
              <div className={`printer-card${p.is_default ? ' default' : ''}`} key={p.id}>
                <div className="pc-hd">
                  <div className="pc-name">{p.name}</div>
                  {p.is_default && <span className="badge badge-green">Default</span>}
                </div>
                <div className="pc-badges">
                  <span className="badge badge-blue">{p.type}</span>
                  <span className={`badge ${connBadge(p.connection)}`}>{p.connection}</span>
                  {p.cash_drawer && <span className="badge badge-amber">Drawer</span>}
                  {p.fiscal && <span className="badge badge-red">Fiscal</span>}
                  {!p.active && <span className="badge badge-gray">Inactive</span>}
                </div>
                <div className="pc-sub">
                  {p.connection === 'Network' && p.ip_address
                    ? `IP ${p.ip_address}`
                    : p.connection === 'Network'
                      ? 'Network'
                      : ''}
                </div>
                <div className="pc-actions">
                  <button className="btn btn-sm" onClick={() => test(p)} disabled={testing === p.id}>
                    {testing === p.id ? 'Printing…' : 'Test print'}
                  </button>
                  {!p.is_default && can('settings.manage') && (
                    <button className="btn btn-sm" onClick={() => setDefault(p)}>
                      Set default
                    </button>
                  )}
                  {can('settings.manage') && (
                    <>
                      <button className="btn btn-sm" onClick={() => openEdit(p)}>
                        Edit
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(p)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {can('settings.manage') && printers.length > 0 && (
          <button className="btn btn-sm mt-3" onClick={openNew}>
            + Add another printer
          </button>
        )}
      </div>

      {creating && (
        <Modal
          title={creating.id ? 'Edit printer' : 'Add receipt printer'}
          onClose={() => setCreating(null)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save}>
                {creating.id ? 'Save' : 'Add'}
              </button>
            </>
          }
        >
          <div className="field">
            <label>Printer name *</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Front till 80mm"
            />
          </div>
          <div className="fields-2">
            <div className="field">
              <label>Paper type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Connection</label>
              <select value={form.connection} onChange={(e) => setForm({ ...form, connection: e.target.value })}>
                {CONNECTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {form.connection === 'Network' && (
            <div className="field">
              <label>IP address</label>
              <input
                value={form.ipAddress}
                onChange={(e) => setForm({ ...form, ipAddress: e.target.value })}
                placeholder="192.168.1.50"
                inputMode="decimal"
              />
            </div>
          )}
          <div className="checks">
            <label className="check">
              <input
                type="checkbox"
                checked={form.cashDrawer}
                onChange={(e) => setForm({ ...form, cashDrawer: e.target.checked })}
              />{' '}
              Cash drawer
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.fiscal}
                onChange={(e) => setForm({ ...form, fiscal: e.target.checked })}
              />{' '}
              Fiscal device
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
              />{' '}
              Set as default printer
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
