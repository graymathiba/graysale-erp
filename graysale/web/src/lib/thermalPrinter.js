/* ============================================================
 * GraySale — Thermal Receipt Printer Engine (ESC/POS)
 *
 * A browser-side module that prints 80mm / 58mm thermal receipts.
 *
 * Delivery modes, auto-selected in order:
 *   1. Web Serial  — direct USB/serial thermal printers (Chrome/Edge on
 *                    desktop AND Android/POPS handheld terminals).
 *   2. WebUSB      — some USB receipt printers (vendor-specific protocol).
 *   3. window.print() fallback — @media print CSS tuned for 80mm/58mm rolls.
 *
 * Cash-drawer kick-out is emitted over Web Serial via the standard RJ11
 * kick command: ESC p 0 x y  ->  \x1B\x70\x00\x19\xFA
 *
 * All functions accept a "doc" (plain JS receipt object) and return the
 * bundle needed by the chosen transport.
 * ============================================================ */

// ---- Low-level byte helpers -------------------------------------
const textEncoder = new TextEncoder();

/** Bytes for a "start" helper when no encoder (legacy browsers). */
function charBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  return Uint8Array.from(out);
}

/** Join an array of byte arrays / strings into one Uint8Array. */
export function concat(parts) {
  const arrays = parts.map((p) => {
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'string') return textEncoder.encode(p);
    return Uint8Array.from(p);
  });
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ---- ESC/POS command builders ------------------------------------
export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;

const CMD = {
  reset: [ESC, 0x40],
  feed: (n) => [ESC, 0x64, Math.max(1, Math.min(n, 255))],
  cut: [GS, 0x56, 0x41, 0x00],                 // full cut
  kick: [ESC, 0x70, 0x00, 0x19, 0xfa],          // cash drawer, pin 2
  printBold: () => Uint8Array.from([ESC, 0x45, 0x01]),
  boldOff: () => Uint8Array.from([ESC, 0x45, 0x00]),
  doubleH: () => Uint8Array.from([GS, 0x21, 0x10]),
  doubleW: () => Uint8Array.from([GS, 0x21, 0x20]),
  doubleHW: () => Uint8Array.from([GS, 0x21, 0x30]),
  normalSize: () => Uint8Array.from([GS, 0x21, 0x00]),
  left: () => Uint8Array.from([ESC, 0x61, 0x00]),
  center: () => Uint8Array.from([ESC, 0x61, 0x01]),
  right: () => Uint8Array.from([ESC, 0x61, 0x02]),
};

/** Build one text line with alignment + optional emphasis. */
export function line(text, { align = 'left', bold = false, size = 'normal' } = {}) {
  const parts = [];
  if (align === 'center') parts.push(CMD.center());
  else if (align === 'right') parts.push(CMD.right());
  else parts.push(CMD.left());
  if (size === 'double') parts.push(CMD.doubleHW());
  else if (size === 'large') parts.push(CMD.doubleH());
  if (bold) parts.push(CMD.printBold());
  parts.push(String(text ?? ''));
  if (bold) parts.push(CMD.boldOff());
  if (size !== 'normal') parts.push(CMD.normalSize());
  parts.push(CMD.left());
  parts.push([LF]);
  return concat(parts);
}

/** Dashes rule of a given width. */
export function rule(ch = '-', width = 42) {
  return line(ch.repeat(width));
}

/** Two-column line: label left, value right. */
export function row(label, value, { width = 42, align = 'left' } = {}) {
  const l = String(label ?? '');
  const r = String(value ?? '');
  if (l.length + r.length > width) {
    return line(`${l}${' '.repeat(Math.max(1, width - (l.length + r.length)))}${r}`);
  }
  return line(`${l}${' '.repeat(width - l.length - r.length)}${r}`);
}

// ---- Receipt document builders -----------------------------------
/**
 * Build an ESC/POS byte stream for a standard POS receipt.
 * @param {object} doc
 *  { company, address, phone, tin, title, docNo, date, cashier, customer,
 *    lines: [{name, qty, priceCents, totalCents}], subtotalCents, taxCents,
 *    totalCents, tenderedCents, changeCents, payments:[{method,amountCents}],
 *    footer, width: 42|32 }
 */
export function buildPosReceipt(doc) {
  const W = doc.width || 42; // 80mm~=42 cols, 58mm~=32 cols
  const cur = doc.currency || '$';
  const c = (v) => ((v ?? 0) / 100).toFixed(2);
  const parts = [];
  parts.push(CMD.reset);

  // Header
  parts.push(line(doc.company || 'STORE', { align: 'center', bold: true, size: 'double' }));
  if (doc.address) parts.push(line(doc.address, { align: 'center' }));
  if (doc.phone) parts.push(line(doc.phone, { align: 'center' }));
  if (doc.tin) parts.push(line(`TIN: ${doc.tin}`, { align: 'center' }));
  parts.push(line(doc.title || 'RECEIPT', { align: 'center', bold: true }));
  parts.push(rule('=', W));
  parts.push(row('Receipt', doc.docNo));
  parts.push(row('Date', doc.date));
  if (doc.cashier) parts.push(row('Cashier', doc.cashier));
  if (doc.customer) parts.push(row('Customer', doc.customer));
  parts.push(rule('-', W));

  // Lines
  if (doc.lines && doc.lines.length) {
    for (const it of doc.lines) {
      parts.push(line(it.name || '', { bold: false }));
      parts.push(row(`  ${it.qty} x ${c(it.priceCents)}`, c(it.totalCents)));
    }
    parts.push(rule('-', W));
  }

  // Totals
  parts.push(row('Subtotal', c(doc.subtotalCents || 0)));
  if (doc.taxName) parts.push(row(doc.taxName, c(doc.taxCents || 0)));
  parts.push(line(`TOTAL ${cur}${c(doc.totalCents)}`, { bold: true, size: 'double' }));

  // Payments
  if (doc.payments && doc.payments.length) {
    parts.push(rule('-', W));
    for (const p of doc.payments) parts.push(row(p.method, c(p.amountCents)));
  }
  if (doc.tenderedCents != null) {
    parts.push(row('Tendered', `${cur}${c(doc.tenderedCents)}`));
    if ((doc.changeCents || 0) > 0) parts.push(row('Change', `${cur}${c(doc.changeCents)}`, ));
  }

  parts.push(rule('=', W));
  if (doc.footer) parts.push(line(doc.footer, { align: 'center', bold: true }));
  parts.push(line('*** THANK YOU ***', { align: 'center' }));
  parts.push(CMD.feed(3));
  parts.push(CMD.cut);
  return concat(parts);
}

/**
 * Build a specialized LAYBY / LAYAWAY receipt with payment history,
 * balance remaining and terms.
 */
export function buildLaybyReceipt(doc) {
  const W = doc.width || 42;
  const cur = doc.currency || '$';
  const c = (v) => ((v ?? 0) / 100).toFixed(2);
  const parts = [];
  parts.push(CMD.reset);
  parts.push(line(doc.company || 'STORE', { align: 'center', bold: true, size: 'double' }));
  parts.push(line('LAYBY / LAYAWAY', { align: 'center', bold: true }));
  parts.push(line('Goods held pending full payment', { align: 'center' }));
  parts.push(rule('=', W));

  parts.push(row('Layby Ref', doc.docNo));
  parts.push(row('Customer', doc.customer));
  parts.push(row('Date', doc.date));
  if (doc.cashier) parts.push(row('Cashier', doc.cashier));
  parts.push(rule('-', W));

  if (doc.lines && doc.lines.length) {
    for (const it of doc.lines) {
      parts.push(line(it.name || ''));
      parts.push(row(`  ${it.qty} x ${c(it.priceCents)}`, c(it.totalCents)));
    }
    parts.push(rule('-', W));
  }

  parts.push(row('Full Price', `${cur}${c(doc.totalCents)}`));
  parts.push(row('Paid (deposit + payments)', `${cur}${c(doc.paidCents)}`));
  parts.push(line(`BALANCE DUE ${cur}${c(doc.balanceCents)}`, { bold: true, size: 'double' }));
  parts.push(rule('-', W));

  // Payment history
  if (doc.paymentHistory && doc.paymentHistory.length) {
    parts.push(line('Payment History', { bold: true }));
    for (const p of doc.paymentHistory) parts.push(row(`${p.date}`, c(p.amountCents)));
    parts.push(rule('-', W));
  }

  if (doc.terms) parts.push(line(doc.terms, { align: 'center', }));
  parts.push(line('Please collect goods once fully paid.', { align: 'center' }));
  parts.push(CMD.feed(3));
  parts.push(CMD.cut);
  return concat(parts);
}

// ---- X / Z report builders ----------------------------------------
/** Build an ESC/POS End-of-Day X-report (or Z-report) byte stream. */
export function buildEodReport(report, { isZ = false } = {}) {
  const W = report.width || 42;
  const cur = report.currency || '$';
  const c = (v) => ((v ?? 0) / 100).toFixed(2);
  const b = report.breakdown || {};
  const parts = [];
  parts.push(CMD.reset);
  parts.push(line(report.company || 'STORE', { align: 'center', bold: true, size: 'double' }));
  parts.push(line(isZ ? 'Z-REPORT (END OF DAY)' : 'X-REPORT', { align: 'center', bold: true }));
  parts.push(rule('=', W));
  parts.push(row('Shift', report.shift?.doc_no));
  parts.push(row('Cashier', report.cashier?.full_name || report.cashier?.username || '—'));
  parts.push(row('Opened', report.shift?.opened_at));
  if (report.shift?.closed_at) parts.push(row('Closed', report.shift.closed_at));
  parts.push(rule('-', W));

  parts.push(row('Opening float', `${cur}${c(report.opening_float_cents)}`));
  parts.push(row('Cash sales', `${cur}${c(b.cash)}`));
  parts.push(row('Card', `${cur}${c(b.card)}`));
  parts.push(row('Mobile', `${cur}${c(b.mobile)}`));
  parts.push(row('Bank', `${cur}${c(b.bank)}`));
  if (b.layby) parts.push(row('Layby deposits', `${cur}${c(b.layby)}`));
  if (b.cashRefund) parts.push(row('Cash refunded', `-${cur}${c(b.cashRefund)}`));
  parts.push(rule('-', W));
  parts.push(row('Sales count', report.sale_count));
  parts.push(row('Layby count', report.layby?.count));
  parts.push(line(`EXPECTED CASH ${cur}${c(report.expected_cash_cents)}`, { bold: true }));
  if (report.counted_cash_cents != null) {
    parts.push(row('Counted cash', `${cur}${c(report.counted_cash_cents)}`));
    const v = report.variance_cents ?? 0;
    parts.push(line(`OVER/SHORT ${cur}${c(Math.abs(v))} ${v >= 0 ? 'OVER' : 'SHORT'}`, { bold: true, size: 'double' }));
  }
  parts.push(rule('=', W));
  parts.push(line(isZ ? 'Shift CLOSED' : 'Shift still open', { align: 'center' }));
  parts.push(CMD.feed(3));
  parts.push(CMD.cut);
  return concat(parts);
}

// ---- Receipt HTML builder (window.print fallback) ------------------
/**
 * Printable HTML styled for 80mm / 58mm thermal rolls. Returns a full
 * <html> string you can open in a hidden iframe/window and call print().
 */
export function buildReceiptHtml(doc, opts = {}) {
  const width = doc.width || 42;
  const is58 = (doc.width || 80) <= 32 || (opts.type === '58mm');
  const mm = is58 ? '58mm' : '80mm';
  const bodyW = is58 ? 48 : 72;
  const cur = doc.currency || '$';
  const c = (v) => ((v ?? 0) / 100).toFixed(2);

  const lineItemRows = (doc.lines || []).map((it) => `
    <tr><td class="l">${esc(it.name || '')}</td><td class="r">${it.qty}x</td><td class="r">${cur}${c(it.priceCents)}</td><td class="r">${cur}${c(it.totalCents)}</td></tr>`).join('');

  const payments = (doc.payments || []).map((p) => `
    <div class="lr"><span>${esc(p.method)}</span><span>${cur}${c(p.amountCents)}</span></div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(doc.title || 'Receipt')} ${esc(doc.docNo || '')}</title>
<style>
  @page { size: ${mm} auto; margin: 2mm; }
  @media print { body { margin: 0; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', 'Consolas', monospace; font-size: 11px; color: #000; width: ${bodyW}mm; margin: 0 auto; padding: 0 1mm; }
  .c { text-align: center; }
  .company { font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
  .title { font-size: 13px; font-weight: 700; margin: 3px 0; text-transform: uppercase; }
  .sub { font-size: 9px; color: #444; }
  hr { border: none; border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1.5px 0; font-size: 10px; vertical-align: top; }
  th { text-align: left; font-size: 9px; border-bottom: 1px solid #000; padding: 2px 0; }
  .r { text-align: right; white-space: nowrap; }
  .lr { display: flex; justify-content: space-between; }
  .total-row td { border-top: 1px solid #000; font-weight: 800; font-size: 13px; padding-top: 4px; }
  .bold { font-weight: 800; }
  .thank { margin-top: 8px; font-size: 11px; text-transform: uppercase; text-align: center; }
  .big { font-size: 14px; font-weight: 800; }
  @media screen { body { border: 1px solid #ddd; padding: 12px; margin: 12px auto; background: #fff; } }
</style></head><body>
  <div class="c company">${esc(doc.company || 'STORE')}</div>
  ${doc.address ? `<div class="c sub">${esc(doc.address)}</div>` : ''}
  ${doc.phone ? `<div class="c sub">Tel: ${esc(doc.phone)}</div>` : ''}
  ${doc.tin ? `<div class="c sub">TIN: ${esc(doc.tin)}</div>` : ''}
  <div class="c title">${esc(doc.title || 'RECEIPT')}</div>
  <hr>
  <div class="lr"><span>No.</span><span>${esc(doc.docNo || '')}</span></div>
  <div class="lr"><span>Date</span><span>${esc(doc.date || '')}</span></div>
  ${doc.cashier ? `<div class="lr"><span>Cashier</span><span>${esc(doc.cashier)}</span></div>` : ''}
  ${doc.customer ? `<div class="lr"><span>Customer</span><span>${esc(doc.customer)}</span></div>` : ''}
  <hr>
  <table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th></tr></thead>
  <tbody>${lineItemRows}</tbody></table>
  <hr>
  <div class="lr"><span>Subtotal</span><span>${cur}${c(doc.subtotalCents || 0)}</span></div>
  ${doc.taxName ? `<div class="lr"><span>${esc(doc.taxName)}</span><span>${cur}${c(doc.taxCents || 0)}</span></div>` : ''}
  <div class="lr total-row"><span>TOTAL</span><span>${cur}${c(doc.totalCents || 0)}</span></div>
  <hr>
  ${payments}
  ${doc.tenderedCents != null ? `<div class="lr"><span>Tendered</span><span>${cur}${c(doc.tenderedCents)}</span></div>` : ''}
  ${(doc.changeCents || 0) > 0 ? `<div class="lr bold"><span>Change</span><span>${cur}${c(doc.changeCents)}</span></div>` : ''}
  <hr>
  ${doc.footer ? `<div class="c">${esc(doc.footer)}</div>` : ''}
  <div class="thank">*** Thank you ***</div>
</body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Transport: window.print fallback ------------------------------
/**
 * Print via a hidden iframe + window.print(). The iframe holds the
 * @media print receipt HTML sized for the roll.
 */
export function printViaWindow(doc, opts = {}) {
  const html = opts.html || buildReceiptHtml(doc, opts);
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.top = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const fdoc = frame.contentDocument;
  fdoc.open();
  fdoc.write(html);
  fdoc.close();
  return new Promise((resolve, reject) => {
    const win = frame.contentWindow;
    const done = () => {
      setTimeout(() => { frame.remove(); resolve(true); }, 500);
    };
    win.onafterprint = done;
    setTimeout(() => {
      try {
        win.focus();
        win.print();
        // resolve optimistically after a timeout in case afterprint never fires
        setTimeout(done, 2000);
      } catch (e) {
        frame.remove();
        reject(e);
      }
    }, 250);
  });
}

// ---- Transport: Web Serial ------------------------------------------
/**
 * Request a serial port and open it for a thermal printer.
 * `navigator.serial` is present when the Web Serial API is available
 * (Chrome/Edge desktop, and Android Chrome).
 */
export async function requestSerialPort({ baudRate = 19200 } = {}) {
  if (!('serial' in navigator)) throw new Error('WEB_SERIAL_NOT_SUPPORTED');
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
  return port;
}

/** Write raw bytes to an open serial port. */
export async function writeSerial(port, bytes) {
  const writer = port.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

/** Open a persisted serial connection (no chooser) after a prior grant. */
export async function getMemorySerialPort() {
  if (!('serial' in navigator)) return null;
  const ports = await navigator.serial.getPorts();
  return ports.length ? ports[0] : null;
}

// ---- Transport: WebUSB ---------------------------------------------
export function usbSupported() {
  return 'usb' in navigator;
}

/** Requests a USB device with the standard printer class. */
export async function requestUsbPrinter() {
  if (!('usb' in navigator)) throw new Error('WEBUSB_NOT_SUPPORTED');
  return navigator.usb.requestDevice({ filters: [] });
}

export async function openUsbPrinter(device) {
  if (!device.opened) await device.open();
  // Try the first configuration and an OUT bulk endpoint.
  const cfg = device.configurations[0];
  let iface = cfg?.interfaces?.find((i) => (i.alternates || []).some((a) => (a.endpoints || []).some((e) => e.direction === 'out')));
  const itf = iface || cfg?.interfaces?.[0];
  if (!itf) throw new Error('NO_USB_INTERFACE');
  if (!device.selectedConfiguration) {
    try { await device.selectConfiguration(cfg.configurationValue); } catch { /* already or unsupported */ }
  }
  try { await device.claimInterface(itf.interfaceNumber); } catch { /* already claimed */ }
  const endpoint = itf.alternates?.[0]?.endpoints?.find((e) => e.direction === 'out');
  return { device, endpoint };
}

export async function writeUsb({ device, endpoint }, bytes) {
  const ep = endpoint?.endpointNumber;
  if (ep != null) await device.transferOut(ep, bytes);
  else await device.transferOut(1, bytes);
}

// ---- High-level: print with auto transport selection ---------------
/**
 * Best-effort print: if a serial printer is connected use ESC/POS bytes,
 * otherwise fall back to window.print() with the roll-matched CSS.
 *
 * @param {object} doc  receipt document (see buildPosReceipt)
 * @param {object} options
 *   - serialPort: an open Web Serial port (if already acquired). When absent,
 *     this attempts to use an already-granted serial port.
 *   - type: '80mm' | '58mm'
 *   - docs: array of { type: 'pos'|'layby'|'x'|'z', doc }
 */
export async function printReceipt(doc, options = {}) {
  const type = options.type || doc.width ? (doc.width <= 32 ? '58mm' : '80mm') : options.type || '80mm';
  doc.width = doc.width || (type === '58mm' ? 32 : 42);

  // 1) Serial (preferred when a port is provided or already granted)
  let port = options.serialPort || null;
  if (!port) {
    try { port = await getMemorySerialPort(); } catch { port = null; }
  }
  if (port) {
    try {
      const bytes = options.builder ? options.builder(doc) : buildPosReceipt(doc);
      await writeSerial(port, bytes);
      return { transport: 'serial', bytes };
    } catch (e) {
      console.warn('Serial print failed, falling back to window.print', e);
    }
  }

  // 2) WebUSB
  if (options.usbPrinter) {
    try {
      const bytes = buildPosReceipt(doc);
      await writeUsb(options.usbPrinter, bytes);
      return { transport: 'usb', bytes };
    } catch (e) {
      console.warn('USB print failed, falling back to window.print', e);
    }
  }

  // 3) window.print() fallback
  await printViaWindow(doc, { type, ...options });
  return { transport: 'window', bytes: null };
}

export default {
  ESC, GS, LF,
  concat, line, rule, row,
  buildPosReceipt, buildLaybyReceipt, buildEodReport, buildReceiptHtml,
  printReceipt, printViaWindow,
  requestSerialPort, writeSerial, getMemorySerialPort,
  requestUsbPrinter, openUsbPrinter, writeUsb, usbSupported,
  KICK: CMD.kick,
};
