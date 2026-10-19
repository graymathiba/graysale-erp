export default function SupportPage() {
  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Support</h1>
          <p>Help, printing and troubleshooting.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-hd">
          <span>Thermal printing</span>
        </div>
        <p>
          Use Web Serial (Chrome/Edge) to print directly to a USB/serial thermal printer from the browser — no server
          software needed.
        </p>
        <ol className="help-list">
          <li>
            In <b>Chrome</b> or <b>Edge</b>, go to a POS checkout and choose a payment method, then print the receipt.
          </li>
          <li>Allow the site to access your serial device when prompted and pick your thermal printer.</li>
          <li>
            If no serial device is available, receipts print through your system print dialog (select your 80mm/58mm
            receipt printer).
          </li>
        </ol>
        <h3 style={{ marginTop: 16 }}>Permissions</h3>
        <p>
          Serial access must be granted on each device. For cash drawers, enable the drawer on the printer and ensure
          the kick command (ESC p) is supported.
        </p>
      </div>
    </div>
  );
}
