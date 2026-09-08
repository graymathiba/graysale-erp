// Shared cents <-> display conversion and small formatters.

export function toCents(v) {
  return Math.round((Number(v) || 0) * 100);
}

export function fmtCents(c, sym = '$') {
  if (c == null || Number.isNaN(c)) c = 0;
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(Math.round(c));
  return `${sign}${sym}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function fmtMoney(cents, cur = '$') {
  return fmtCents(cents, cur);
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDT(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateFull(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Badge class for a business status.
export function statusBadge(status) {
  const map = {
    PAID: 'badge-green', OPEN: 'badge-amber', PARTIAL: 'badge-sky', COMPLETED: 'badge-green',
    VOID: 'badge-red', DRAFT: 'badge-gray', ORDERED: 'badge-sky', RECEIVED: 'badge-green',
    CONVERTED: 'badge-gray', ACTIVE: 'badge-green', INACTIVE: 'badge-gray',
    // Control Tower tenant states
    ACTIVE: 'badge-green', BLOCKED: 'badge-red', EXPIRED: 'badge-amber', PENDING_KEY: 'badge-violet',
    PENDING_ACTIVATION: 'badge-violet',
    // Control Tower key states
    UNUSED: 'badge-blue', REDEEMED: 'badge-green', REVOKED: 'badge-gray',
  };
  const cls = map[status] || 'badge-gray';
  const label = status || '—';
  return { cls, label };
}

export function initials(name = '') {
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0]?.toUpperCase() || '');
}

export const hashString = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
};

export const avatarHue = (name) => hashString(String(name)) % 360;
