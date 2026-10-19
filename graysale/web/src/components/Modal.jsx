import { useEffect } from 'react';

// Lightweight accessible modal. Renders into #modal-root via a portal.
export default function Modal({ title, onClose, footer, children, wide }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-hd">
          <span>{title}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-bd">{children}</div>
        {footer ? <div className="modal-ft">{footer}</div> : null}
      </div>
    </div>
  );
}
