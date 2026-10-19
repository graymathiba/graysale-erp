// Cart, tender and keypad state for the classic POS terminal.
// Deliberately returns the same names the component used as local state, so
// the terminal destructures this hook and its JSX does not change.

import { useState, useRef, useCallback, useMemo } from 'react';
import { useToast } from '../components/Toast';

export default function usePOSCart() {
  const toast = useToast();

  // ---------- cart ----------
  const [cart, setCart] = useState([]);
  const [sel, setSel] = useState(-1);
  const [discPct, setDiscPct] = useState(0);
  const [qtyEntry, setQtyEntry] = useState('');

  // ---------- payment tender ----------
  const [payMethod, setPayMethod] = useState('CASH');
  const [tender, setTender] = useState('');
  // What the keypad is typing right now: 'qty' while ringing items,
  // 'tender' while the payment screen is open. Never inferred from the
  // payment method — the cashier always sees which one is live.
  const [keyTarget, setKeyTarget] = useState('qty');

  const productMapRef = useRef(new Map());

  // ---------- cart math ----------
  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, l) => s + l.unitCents * l.qty, 0);
    const disc = Math.round(subtotal * (discPct / 100));
    const total = subtotal - disc;
    const grandQty = cart.reduce((s, l) => s + l.qty, 0);
    // per-line discount allocation (basis points of gross share)
    const lines = cart.map((l) => {
      const share = subtotal ? (l.unitCents * l.qty) / subtotal : 0;
      return { ...l, lineDisc: Math.round(disc * share), lineTotal: l.unitCents * l.qty - Math.round(disc * share) };
    });
    return { subtotal, disc, total, grandQty, lines };
  }, [cart, discPct]);

  const tenderCents = Math.max(0, Math.round(Number(tender || 0) * 100) || 0);
  const changeCents = payMethod === 'CASH' && tenderCents > totals.total ? tenderCents - totals.total : 0;

  // ---------- cart ops ----------
  // Mirrors the server's resolvePrice(): the best quantity tier that fits is
  // applied automatically. Cashiers never pick a tier by hand, so the screen
  // always shows the price the till will actually charge.
  const pickTierPrice = useCallback((p, qty) => {
    const tiers = (p?.tiers || []).filter((t) => t.active !== 0 && qty >= (t.min_qty || 1));
    if (!tiers.length) return p?.price_cents ?? 0;
    return tiers.reduce((best, t) => (t.min_qty > best.min_qty ? t : best), tiers[0]).price_cents;
  }, []);

  const addProduct = useCallback(
    (p, qt = 1) => {
      const i = cart.findIndex((l) => l.productId === p.id);
      productMapRef.current.set(p.id, p);
      if (i >= 0) {
        const n = [...cart];
        const qty = n[i].qty + qt;
        n[i] = { ...n[i], qty, unitCents: pickTierPrice(n[i].product ?? p, qty) };
        setCart(n);
        setSel(i); // stays on the merged row — no blank status bar
      } else {
        setCart([
          ...cart,
          {
            key: p.id,
            productId: p.id,
            product: p,
            sku: p.sku || '',
            barcode: p.barcode || p.sku || '',
            name: p.name,
            unitCents: pickTierPrice(p, qt),
            qty: qt,
            bin: '',
          },
        ]);
        setSel(cart.length);
      }
    },
    [cart, pickTierPrice],
  );

  const setLineQty = useCallback(
    (idx, qty) => {
      setCart((c) => {
        const n = [...c];
        if (qty <= 0) {
          n.splice(idx, 1);
          if (sel >= idx) setSel((s) => Math.max(-1, s - 1));
          return n;
        }
        const line = n[idx];
        const product = line.product || productMapRef.current.get(line.productId);
        n[idx] = { ...line, qty, unitCents: pickTierPrice(product, qty) };
        return n;
      });
    },
    [sel, pickTierPrice],
  );

  const removeLine = useCallback(
    (idx) => {
      setCart((c) => {
        const n = [...c];
        n.splice(idx, 1);
        return n;
      });
      setSel((s) => (s >= cart.length - 1 ? cart.length - 2 : s));
    },
    [cart.length],
  );

  const removeSelected = useCallback(() => {
    if (sel >= 0 && sel < cart.length) removeLine(sel);
    else toast.warn('No line selected');
  }, [sel, cart.length, removeLine, toast]);

  const clearCart = useCallback(() => {
    setCart([]);
    setSel(-1);
    setDiscPct(0);
    setTender('');
    setPayMethod('CASH');
    setKeyTarget('qty');
    setQtyEntry('');
  }, []);

  // ---------- keypad ----------
  const pressDigit = (d) => {
    if (keyTarget === 'tender') setTender((t) => (t + d).replace(/^0+(?=\d)/, ''));
    else setQtyEntry((e) => (e + d).replace(/^0+(?=\d)/, ''));
  };
  const pressDot = () => {
    if (keyTarget === 'tender') setTender((t) => (t.includes('.') ? t : t + '.'));
    else setQtyEntry((e) => (e.includes('.') ? e : e + '.'));
  };
  const pressMinus = () => {
    if (sel >= 0 && sel < cart.length) setLineQty(sel, cart[sel].qty - 1);
    else toast.warn('No line selected');
  };

  const applyQty = () => {
    if (!qtyEntry) {
      return false;
    }
    if (sel < 0 || sel >= cart.length) {
      toast.warn('Select a line first');
      return false;
    }
    if (String(qtyEntry).includes('.')) {
      toast.warn('Quantity must be a whole number');
      setQtyEntry('');
      return false;
    }
    const v = parseInt(qtyEntry, 10);
    setLineQty(sel, Number.isNaN(v) ? 1 : v);
    setQtyEntry('');
    return true;
  };

  return {
    cart,
    setCart,
    sel,
    setSel,
    discPct,
    setDiscPct,
    qtyEntry,
    setQtyEntry,
    payMethod,
    setPayMethod,
    tender,
    setTender,
    keyTarget,
    setKeyTarget,
    productMapRef,
    totals,
    tenderCents,
    changeCents,
    addProduct,
    setLineQty,
    removeSelected,
    clearCart,
    pressDigit,
    pressDot,
    pressMinus,
    applyQty,
  };
}
