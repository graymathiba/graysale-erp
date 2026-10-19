// Printable A4 document for Quotations / Invoices.
// Company header, line items, totals, and the statutory/banking block are
// all injected dynamically from `companySettings` (managed by the Owner).
// Styled with dedicated `.doc-*` classes so it prints cleanly on A4.

export default function DynamicDocumentPrint({ companySettings = {}, documentData = {} }) {
  const cs = companySettings;
  const {
    docType = 'QUOTATION',
    docNumber = '',
    date = '',
    dueDate = '',
    customerName = '',
    items = [],
    totalAmount = 0,
  } = documentData;

  const bank = cs.banking_details?.[0];
  const fmt = (n) => '$' + (Number(n) || 0).toFixed(2);

  return (
    <div className="doc">
      {/* Header */}
      <div className="doc-hd">
        <div className="doc-logo">
          <div className="doc-logo-name">{cs.trading_as || cs.company_name}</div>
          {cs.tagline && <div className="doc-logo-tag">&ldquo;{cs.tagline}&rdquo;</div>}
          <div className="doc-legal">
            {cs.company_name}
            {cs.trading_as && <> T/A {cs.trading_as}</>}
          </div>
          <div className="doc-contacts">
            {cs.address && <div>{cs.address}</div>}
            {cs.telephone && <div>TEL: {cs.telephone}</div>}
            {cs.mobile && <div>CELL: {cs.mobile}</div>}
          </div>
        </div>
        <div className="doc-title">
          <div className="doc-title-type">{docType}</div>
          <div className="doc-title-no">#{docNumber || customerName}</div>
          <div className="doc-meta">
            {date && (
              <div>
                <span>Date:</span>
                <span>{date}</span>
              </div>
            )}
            {dueDate && (
              <div>
                <span>:</span>
                <span>{dueDate}</span>
              </div>
            )}
          </div>
          <div className="doc-balance">
            <span>Balance Due:</span>
            <span>{fmt(totalAmount)}</span>
          </div>
        </div>
      </div>

      {/* Bill To */}
      {customerName && (
        <div className="doc-bill">
          <div className="doc-bill-lbl">Bill To:</div>
          <div className="doc-bill-name">{customerName}</div>
        </div>
      )}

      {/* Items */}
      <table className="doc-table">
        <thead>
          <tr>
            <th className="doc-t-item">Item</th>
            <th className="doc-t-num">Quantity</th>
            <th className="doc-t-num">Rate</th>
            <th className="doc-t-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="doc-t-item">{it.description}</td>
              <td className="doc-t-num">{it.quantity}</td>
              <td className="doc-t-num">{fmt(it.rate)}</td>
              <td className="doc-t-num">{fmt(it.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="doc-total">
        <div>
          <span>Total:</span>
          <span>{fmt(totalAmount)}</span>
        </div>
      </div>

      {/* Banking + statutory */}
      <div className="doc-foot">
        <div className="doc-bank">
          <div className="doc-bank-row">
            <span>{bank?.bank_name}</span>
            <span>{bank?.branch}</span>
          </div>
          <div className="doc-bank-acct">{bank?.account_name}</div>
          {bank?.usd_account && <div>BANK ACCOUNT NUMBER USD:{bank.usd_account}</div>}
          {bank?.zig_account && <div>Bank acc number for ZiG:{bank.zig_account}</div>}
        </div>
        <div className="doc-stat">
          {cs.reg_number && <div>REG NO: {cs.reg_number}</div>}
          {cs.tin_number && <div>TIN: {cs.tin_number}</div>}
          {cs.vat_number && <div>VAT NO: {cs.vat_number}</div>}
        </div>
      </div>
    </div>
  );
}
