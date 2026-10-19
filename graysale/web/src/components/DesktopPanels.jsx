import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from './Toast';
import { api } from '../api/client';
import { fmtDT } from '../lib/format';
import DesktopIcon from './DesktopIcons';

const TYPES = ['80mm', '58mm'];
const CONNECTIONS = ['USB', 'NETWORK', 'SERIAL'];

/* ================= Hardware Setup =================
   Printer list docked in the workspace — same CRUD as /settings printers,
   trimmed for cashier-floor use (default printer, cash drawer, fiscal). */
export function HardwareSetupPanel({ onClose }) {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('settings.manage');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: '', type: '80mm', connection: 'USB', ipAddress: '' });

  const load = useCallback(async () => {
    try {
      const list = await api.get('/printers');
      setRows(Array.isArray(list) ? list : []);
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = (id, fields) => setRows((r) => r.map((p) => (p.id === id ? { ...p, ...fields } : p)));

  const saveRow = async (p) => {
    setBusy(true);
    try {
      await api.put(`/printers/${p.id}`, {
        name: p.name,
        type: p.type,
        connection: p.connection,
        ipAddress: p.ip_address || null,
        cashDrawer: !!p.cash_drawer,
        fiscal: !!p.fiscal,
        active: p.active !== 0,
        ...(p.is_default ? { isDefault: true } : {}),
      });
      toast.ok(`Printer "${p.name}" saved`);
      load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (p) => {
    setBusy(true);
    try {
      // PUT ignores bodies without a mapped key — send the name alongside.
      await api.put(`/printers/${p.id}`, { name: p.name, isDefault: true });
      toast.ok(`"${p.name}" is now the default printer`);
      load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete printer "${p.name}"?`)) return;
    setBusy(true);
    try {
      await api.del(`/printers/${p.id}`);
      load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addPrinter = async () => {
    if (!draft.name.trim()) {
      toast.warn('Printer name is required');
      return;
    }
    setBusy(true);
    try {
      await api.post('/printers', {
        name: draft.name.trim(),
        type: draft.type,
        connection: draft.connection,
        ipAddress: draft.ipAddress || undefined,
        cashDrawer: false,
        fiscal: false,
      });
      setDraft({ name: '', type: '80mm', connection: 'USB', ipAddress: '' });
      load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dsk-hw">
      {rows.length === 0 && <div className="dsk-hw-empty">No printers configured yet.</div>}
      {rows.map((p) => (
        <div key={p.id} className={`dsk-hw-row${p.is_default ? ' is-default' : ''}`}>
          <div className="dsk-hw-name">
            <b>{p.name}</b>
            {p.is_default ? <span className="badge badge-blue">Default</span> : null}
            {p.active === 0 ? <span className="badge badge-gray">Off</span> : null}
          </div>
          {editable ? (
            <div className="dsk-hw-fields">
              <label>
                Type
                <select value={p.type || '80mm'} onChange={(e) => patch(p.id, { type: e.target.value })}>
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Link
                <select value={p.connection || 'USB'} onChange={(e) => patch(p.id, { connection: e.target.value })}>
                  {CONNECTIONS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              {p.connection === 'NETWORK' ? (
                <label>
                  IP
                  <input
                    className="mono"
                    value={p.ip_address || ''}
                    onChange={(e) => patch(p.id, { ip_address: e.target.value })}
                    placeholder="192.168.0.10"
                  />
                </label>
              ) : null}
              <label className="dsk-hw-chk">
                <input
                  type="checkbox"
                  checked={!!p.cash_drawer}
                  onChange={(e) => patch(p.id, { cash_drawer: e.target.checked ? 1 : 0 })}
                />
                Cash drawer
              </label>
              <label className="dsk-hw-chk">
                <input
                  type="checkbox"
                  checked={!!p.fiscal}
                  onChange={(e) => patch(p.id, { fiscal: e.target.checked ? 1 : 0 })}
                />
                Fiscal
              </label>
              <label className="dsk-hw-chk">
                <input
                  type="checkbox"
                  checked={p.active !== 0}
                  onChange={(e) => patch(p.id, { active: e.target.checked ? 1 : 0 })}
                />
                Active
              </label>
            </div>
          ) : (
            <div className="dsk-hw-ro">
              {p.type} · {p.connection}
              {p.ip_address ? ` · ${p.ip_address}` : ''}
              {p.cash_drawer ? ' · drawer' : ''}
              {p.fiscal ? ' · fiscal' : ''}
            </div>
          )}
          {editable ? (
            <div className="dsk-hw-acts">
              <button className="btn btn-sm" disabled={busy} onClick={() => saveRow(p)}>
                Save
              </button>
              {!p.is_default ? (
                <button className="btn btn-sm" disabled={busy} onClick={() => makeDefault(p)}>
                  Make Default
                </button>
              ) : null}
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(p)}>
                Delete
              </button>
            </div>
          ) : null}
        </div>
      ))}

      {editable ? (
        <div className="dsk-hw-add">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="New printer name…"
          />
          <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select value={draft.connection} onChange={(e) => setDraft({ ...draft, connection: e.target.value })}>
            {CONNECTIONS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          {draft.connection === 'NETWORK' ? (
            <input
              className="mono"
              value={draft.ipAddress}
              onChange={(e) => setDraft({ ...draft, ipAddress: e.target.value })}
              placeholder="IP address"
            />
          ) : null}
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={addPrinter}>
            <DesktopIcon name="plus" size={13} /> Add
          </button>
        </div>
      ) : (
        <div className="dsk-hw-empty">Read-only: your role cannot change hardware.</div>
      )}
      <button className="btn btn-sm dsk-hw-close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/* ================= Activity Log ================= */
export function ActivityLogPanel({ onClose }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/audit?limit=60');
        setRows(Array.isArray(r) ? r : []);
      } catch (e) {
        if (!e?.silent) toast.err(e.message);
      }
    })();
  }, [toast]);

  return (
    <div className="dsk-act">
      {rows.length === 0 ? (
        <div className="dsk-hw-empty">No activity recorded yet.</div>
      ) : (
        <table className="dsk-act-table">
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Action</th>
              <th>Entity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{fmtDT(r.created_at)}</td>
                <td>{r.username || '—'}</td>
                <td className="mono">{r.action}</td>
                <td className="mono">
                  {r.entity_type ? `${r.entity_type}${r.entity_id ? ' #' + r.entity_id : ''}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="btn btn-sm dsk-hw-close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/* ================= Calculator ================= */
export function CalculatorPanel({ onClose }) {
  const [disp, setDisp] = useState('0');
  const [acc, setAcc] = useState(null);
  const [op, setOp] = useState(null);
  const [fresh, setFresh] = useState(true); // next digit starts a new number

  const digit = (d) => {
    setDisp((s) => (fresh || s === '0' ? (d === '.' ? '0.' : d) : d === '.' && s.includes('.') ? s : s + d));
    setFresh(false);
  };

  const apply = (a, b, o) => {
    if (o === '+') return a + b;
    if (o === '-') return a - b;
    if (o === '×') return a * b;
    if (o === '÷') return b === 0 ? NaN : a / b;
    return b;
  };

  const doOp = (o) => {
    const v = parseFloat(disp) || 0;
    if (acc != null && op && !fresh) {
      const r = apply(acc, v, op);
      setAcc(r);
      setDisp(String(Number(r.toFixed(8))));
    } else setAcc(v);
    setOp(o);
    setFresh(true);
  };

  const equals = () => {
    const v = parseFloat(disp) || 0;
    if (acc == null || !op) return;
    const r = apply(acc, v, op);
    setDisp(Number.isFinite(r) ? String(Number(r.toFixed(8))) : 'ERROR');
    setAcc(null);
    setOp(null);
    setFresh(true);
  };

  const keys = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '-', '0', '.', '=', '+'];
  return (
    <div className="dsk-calc">
      <div className="dsk-calc-disp mono" aria-live="polite">
        {disp}
      </div>
      <div className="dsk-calc-grid">
        {keys.map((k) => (
          <button
            key={k}
            className={k === '=' ? 'kc-eq' : /[0-9.]/.test(k) ? 'kc-num' : 'kc-op'}
            onClick={() => {
              if (/[0-9.]/.test(k)) digit(k);
              else if (k === '=') equals();
              else doOp(k);
            }}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="dsk-calc-acts">
        <button
          className="btn btn-sm"
          onClick={() => {
            setDisp('0');
            setAcc(null);
            setOp(null);
            setFresh(true);
          }}
        >
          Clear
        </button>
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/* ================= Stub + About ================= */
export function StubPanel({ label, onClose }) {
  return (
    <div className="dsk-stub">
      <DesktopIcon name="info" size={28} />
      <h3>{label}</h3>
      <p>This module is not available in the web build yet. It is reserved for a future release of GraySale Classic.</p>
      <button className="btn btn-primary btn-sm" onClick={onClose}>
        OK
      </button>
    </div>
  );
}

export function AboutPanel({ company, username, onClose }) {
  return (
    <div className="dsk-stub">
      <DesktopIcon name="monitor" size={28} />
      <h3>GraySale Classic Desktop</h3>
      <p>
        {company || 'GraySale ERP'}
        <br />
        Signed in as <b>{username}</b>
        <br />
        Web build · retail workspace mode
      </p>
      <button className="btn btn-sm" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
