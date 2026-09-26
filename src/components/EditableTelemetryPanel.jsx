import { useRef, useState } from 'react';

export default function EditableTelemetryPanel({ id, label, layout, order, selected, onSelect, onResize, onMove, onReorder, onReset, children, placement, fit = false }) {
  const ref = useRef(null);
  const gesture = useRef(null);
  const [preview, setPreview] = useState(null);
  const [moving, setMoving] = useState(false);
  const size = preview || layout;
  const begin = (event, kind) => {
    event.preventDefault(); event.stopPropagation();
    const grid = ref.current.parentElement;
    const style = getComputedStyle(grid);
    gesture.current = { kind, x: event.clientX, y: event.clientY, layout, grid,
      col: (grid.clientWidth + parseFloat(style.columnGap || 0)) / 12,
      row: ref.current.offsetHeight / layout.rows };
    event.currentTarget.setPointerCapture(event.pointerId);
    setMoving(kind === 'move');
  };
  const move = (event) => {
    const g = gesture.current;
    if (!g || g.kind !== 'resize') return;
    setPreview({ cols: Math.max(3, Math.min(12, g.layout.cols + Math.round((event.clientX - g.x) / g.col))),
      rows: Math.max(1, Math.min(8, g.layout.rows + Math.round((event.clientY - g.y) / g.row))) });
  };
  const end = (event, cancelled = false) => {
    const g = gesture.current;
    if (!g) return;
    if (!cancelled && g.kind === 'resize' && preview) onResize(preview);
    if (!cancelled && g.kind === 'move') {
      let target = document.elementFromPoint(event.clientX, event.clientY);
      while (target && target.parentElement !== g.grid) target = target.parentElement;
      if (target?.dataset.telemetryItem && target !== ref.current) onReorder(target.dataset.telemetryItem);
    }
    gesture.current = null; setPreview(null); setMoving(false);
  };
  const adjust = (key, delta) => onResize({ ...layout, [key]: Math.max(key === 'cols' ? 3 : 1, Math.min(key === 'cols' ? 12 : 8, layout[key] + delta)) });
  const buttonClass = 'min-h-11 rounded-lg border border-white/25 bg-slate-800 px-3 text-sm font-semibold text-white disabled:opacity-40';
  return <section ref={ref} data-telemetry-item={id} aria-label={label} tabIndex={0}
    onClick={(event) => { event.stopPropagation(); if (!event.target.closest('button,input,select,a,textarea')) onSelect(id); }}
    onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(id); } if (event.key === 'Escape') onSelect(''); }}
    className={`relative min-h-0 min-w-0 rounded-xl ${selected ? 'ring-2 ring-cyan-300 z-10' : ''} ${moving ? 'opacity-60' : ''}`}
    style={{ gridColumn: `span ${size.cols}`, gridRow: `span ${size.rows}`, order, ...(placement ? { gridColumn: `${placement.x + 1} / span ${placement.cols}`, gridRow: `${placement.y + 1} / span ${placement.rows}` } : {}) }}>
    <div className={`h-full min-h-0 rounded-xl ${fit ? "" : "overflow-auto"}`} style={{ containerType: 'inline-size' }}>{children}</div>
    {selected && <>
      <button type="button" aria-label={`Drag ${label} to move`} onPointerDown={(e) => begin(e, 'move')} onPointerUp={end} onPointerCancel={(e) => end(e, true)}
        className="absolute left-1 top-1 z-20 min-h-11 touch-none rounded-lg border border-cyan-200 bg-slate-950 px-3 text-sm font-bold text-white">↔ Move</button>
      <button type="button" aria-label={`Drag to resize ${label}`} onPointerDown={(e) => begin(e, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={(e) => end(e, true)}
        className="absolute bottom-0 right-0 z-20 h-11 w-11 touch-none rounded-tl-xl border border-cyan-200 bg-slate-950 text-2xl text-white">↘</button>
      <div role="toolbar" aria-label={`${label} options`} onClick={(e) => e.stopPropagation()} className="fixed bottom-3 left-1/2 z-[95] flex max-h-[45dvh] w-max max-w-[96vw] -translate-x-1/2 flex-wrap items-center justify-center gap-2 overflow-auto rounded-xl border border-cyan-300 bg-slate-950 p-3 text-white shadow-xl">
        <strong className="w-full text-center text-sm">{label} · Drag Move or the corner · Saved automatically</strong>
        <button type="button" className={buttonClass} onClick={() => onMove(-1)}>← Earlier</button>
        <button type="button" className={buttonClass} onClick={() => onMove(1)}>Later →</button>
        <button type="button" className={buttonClass} disabled={layout.cols <= 3} onClick={() => adjust('cols', -1)}>Narrower</button>
        <button type="button" className={buttonClass} disabled={layout.cols >= 12} onClick={() => adjust('cols', 1)}>Wider</button>
        <button type="button" className={buttonClass} disabled={layout.rows <= 1} onClick={() => adjust('rows', -1)}>Shorter</button>
        <button type="button" className={buttonClass} disabled={layout.rows >= 8} onClick={() => adjust('rows', 1)}>Taller</button>
        <button type="button" className={buttonClass} onClick={onReset}>Reset size</button>
        <button type="button" className={buttonClass} onClick={() => onSelect('')}>Done</button>
      </div>
    </>}
  </section>;
}
