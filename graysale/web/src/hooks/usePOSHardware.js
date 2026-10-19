import { useEffect, useRef, useCallback } from 'react';
import { printReceipt, writeSerial, requestSerialPort, getMemorySerialPort } from '../lib/thermalPrinter';

/**
 * usePOSHardware — workstation I/O for the classic POS terminal.
 *
 *  * Global keydown listeners: F2/F5 (Pay), F3 (Print), F4 (Hold/Recall),
 *    Delete (remove row), Enter/Arrows (navigate/process), Escape.
 *  * Hardware barcode-scanner buffer: printable keys typed outside an editable
 *    field accumulate; a terminal Enter commits the buffer as a scan code.
 *  * ESC/POS thermal printing (Web Serial / Web USB, window.print fallback)
 *    and RJ11 cash-drawer kick (ESC p 0 25 250) over Web Serial.
 *
 * @param {object} opts
 *  - onCommand:(cmd)   cmd in F2|F3|F4|F5|Delete|Enter|Escape|ArrowUp|ArrowDown
 *  - onScan:(code)     committed scanner/barcode buffer
 */
export default function usePOSHardware({ onCommand, onScan } = {}) {
  const onCommandRef = useRef(onCommand);
  const onScanRef = useRef(onScan);
  onCommandRef.current = onCommand;
  onScanRef.current = onScan;

  const bufferRef = useRef('');
  const portRef = useRef(null);

  useEffect(() => {
    const isEditable = (t) =>
      !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    const onKey = (e) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const editable = isEditable(t);

      // Function keys always fire (preventDefault stops F5 refresh / F3 find).
      if (e.key === 'F2' || e.key === 'F3' || e.key === 'F4' || e.key === 'F5') {
        e.preventDefault();
        if (!e.repeat) onCommandRef.current?.(e.key);
        return;
      }

      // Escape closes anything (ignored inside inputs).
      if (e.key === 'Escape' && !editable) {
        e.preventDefault();
        onCommandRef.current?.('Escape');
        return;
      }

      // Row navigation is only interesting outside text fields.
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !editable
      ) {
        e.preventDefault();
        onCommandRef.current?.(e.key);
        return;
      }

      if (editable) {
        // A field marked data-pos-enter uses Enter to process (e.g. tender).
        if (e.key === 'Enter' && t.dataset && t.dataset.posEnter === '1') {
          e.preventDefault();
          onCommandRef.current?.('Enter');
        }
        return;
      }

      switch (e.key) {
        case 'Delete':
          e.preventDefault();
          if (!e.repeat) onCommandRef.current?.('Delete');
          return;
        case 'Enter': {
          e.preventDefault();
          if (bufferRef.current) {
            const code = bufferRef.current;
            bufferRef.current = '';
            onScanRef.current?.(code);
          } else {
            onCommandRef.current?.('Enter');
          }
          return;
        }
        case 'Backspace':
          bufferRef.current = bufferRef.current.slice(0, -1);
          return;
        case 'Tab':
        case 'Shift':
        case 'CapsLock':
        case 'Alt':
        case 'Control':
        case 'Meta':
          return;
        default:
          if (e.key && e.key.length === 1) {
            bufferRef.current += e.key;
            // avoid integer overflow on long scan jobs
            if (bufferRef.current.length > 60) bufferRef.current = bufferRef.current.slice(-60);
          }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Ensure a Web Serial port is available (reuses a previously opened one). */
  const ensurePort = useCallback(async () => {
    if (portRef.current) return portRef.current;
    try {
      const existing = await getMemorySerialPort();
      if (existing) {
        portRef.current = existing;
        return existing;
      }
    } catch {
      /* no persisted grants */
    }
    const p = await requestSerialPort();
    portRef.current = p;
    return p;
  }, []);

  /** Print a receipt doc through the best available transport. */
  const print = useCallback(async (doc, opts = {}) => {
    try {
      const result = await printReceipt(doc, opts);
      if (opts.onTransport) opts.onTransport(result.transport);
      return result;
    } catch (e) {
      throw new Error(`Print failed: ${e.message || e}`);
    }
  }, []);

  /** Kick the RJ11 cash drawer: ESC p 0 25 250. Uses Web Serial when possible. */
  const openCashDrawer = useCallback(async () => {
    let port = null;
    if ('serial' in navigator) {
      try {
        port = await ensurePort();
      } catch {
        port = null;
      }
    }
    if (port) {
      const kick = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa, 0x1b, 0x64, 0x02]);
      await writeSerial(port, kick);
      return { transport: 'serial' };
    }
    throw new Error('No serial port available for cash drawer');
  }, [ensurePort]);

  /** Explicitly connect to a thermal printer (shows the Chrome chooser). */
  const connectPrinter = useCallback(async () => {
    const port = await ensurePort();
    return port;
  }, [ensurePort]);

  /** Manually inject a scan (e.g. captured from an external popup/scanner). */
  const injectScan = useCallback((code) => {
    if (code) onScanRef.current?.(String(code));
  }, []);

  return {
    print,
    openCashDrawer,
    connectPrinter,
    injectScan,
  };
}
