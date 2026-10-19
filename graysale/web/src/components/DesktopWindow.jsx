import { useCallback, useEffect, useRef, useState } from 'react';
import DesktopIcon from './DesktopIcons';

/**
 * DesktopWindow — a small draggable window that lives inside the workspace.
 * `docked` windows park bottom-right until the user drags them; after that the
 * position sticks (kept in component state, workspace-relative).
 */
export default function DesktopWindow({ title, icon = 'grid', width = 430, docked = false, onClose, children }) {
  const hostRef = useRef(null); // .dsk-work (positioned ancestor)
  const [pos, setPos] = useState(null); // { x, y } workspace-relative px
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);

  const clamp = useCallback((x, y, w) => {
    const host = hostRef.current?.parentElement;
    const hw = host?.clientWidth || 1200;
    const hh = host?.clientHeight || 800;
    return { x: Math.max(4, Math.min(x, hw - w - 4)), y: Math.max(4, Math.min(y, hh - 60)) };
  }, []);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const host = hostRef.current?.parentElement;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const win = e.currentTarget.closest('.dsk-win');
    const winRect = win?.getBoundingClientRect();
    // Materialise the docked position so dragging starts from where it sits.
    const startX = pos ? pos.x : winRect.left - hostRect.left;
    const startY = pos ? pos.y : winRect.top - hostRect.top;
    dragRef.current = {
      dx: e.clientX - (hostRect.left + startX),
      dy: e.clientY - (hostRect.top + startY),
      w: winRect?.width || width,
    };
    setDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e) => {
      const d = dragRef.current;
      const host = hostRef.current?.parentElement;
      if (!d || !host) return;
      const r = host.getBoundingClientRect();
      setPos(clamp(e.clientX - r.left - d.dx, e.clientY - r.top - d.dy, d.w));
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging, clamp]);

  const style = pos
    ? { left: pos.x, top: pos.y, width }
    : docked
      ? { right: 14, bottom: 14, width }
      : { left: '50%', top: 80, width, transform: 'translateX(-50%)' };

  return (
    <div className="dsk-win" ref={hostRef} style={style} role="dialog" aria-label={title}>
      <div className={`dsk-win-hd${dragging ? ' dragging' : ''}`} onMouseDown={onPointerDown}>
        <span className="dsk-win-title">
          <DesktopIcon name={icon} size={14} />
          {title}
        </span>
        <button className="dsk-win-x" onClick={onClose} aria-label={`Close ${title}`}>
          <DesktopIcon name="x" size={12} />
        </button>
      </div>
      <div className="dsk-win-bd">{children}</div>
    </div>
  );
}
