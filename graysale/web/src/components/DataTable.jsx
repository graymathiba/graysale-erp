import { statusBadge } from '../lib/format';

// Generic data table. Columns: { key, label, render, num, width }.
export function Badge({ status }) {
  const { cls, label } = statusBadge(status);
  return <span className={`badge ${cls}`}>{label}</span>;
}

export default function DataTable({ columns, rows, empty = 'No records', rowKey, onRowClick, caption, zebra = true }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="panel">
        {caption ? <div className="panel-hd">{caption}</div> : null}
        <div className="empty-state">{empty}</div>
      </div>
    );
  }
  return (
    <div className="panel">
      {caption ? <div className="panel-hd">{caption}</div> : null}
      <div className="grid-wrap">
        <table className={`grid${zebra ? ' zebra' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''} style={c.width ? { width: c.width } : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={rowKey ? rowKey(r) : i}
                className={onRowClick ? 'clickable' : ''}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>
                    {c.render ? c.render(r, i) : (r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
