import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // key (msg+knd) -> timeout. Identical live toasts are refreshed, never stacked.
  const timersRef = useRef(new Map());

  const push = useCallback((msg, kind = '') => {
    const key = `${kind}\u0000${msg}`;
    clearTimeout(timersRef.current.get(key));
    const timer = setTimeout(() => {
      timersRef.current.delete(key);
      setToasts((s) => s.filter((t) => t.key !== key));
    }, 3400);
    timersRef.current.set(key, timer);
    setToasts((s) => {
      if (s.some((t) => t.key === key)) return [...s]; // already showing — just refreshed the timer
      return [...s, { key, msg, kind }];
    });
  }, []);

  // Bridge so non-React code (api/client.js) can raise toasts via window events.
  useEffect(() => {
    const onToast = (e) => {
      if (e.detail && e.detail.msg) push(e.detail.msg, e.detail.kind || '');
    };
    window.addEventListener('app:toast', onToast);
    return () => window.removeEventListener('app:toast', onToast);
  }, [push]);

  const toast = {
    show: (m) => push(m, ''),
    ok: (m) => push(m, 'ok'),
    err: (m) => push(m, 'err'),
    warn: (m) => push(m, 'warn'),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div id="toast-wrap">
        {toasts.map((t) => (
          <div key={t.key} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
