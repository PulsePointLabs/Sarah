import { Children, Fragment, isValidElement, useLayoutEffect, useRef, useState, useEffect } from 'react';
import EditableTelemetryPanel from './EditableTelemetryPanel';
import { packTelemetry } from '@/lib/telemetryPacking';
import './viewportTelemetry.css';

const STORAGE = 'pulsepoint.telemetryViewport.v1';
function flatten(children) {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment || child.props.className === 'contents') return flatten(child.props.children);
    return [child];
  });
}

function FitContents({ children, metric, phase }) {
  const outer = useRef(null), inner = useRef(null);
  const [box, setBox] = useState({ width: 460, height: 280, scale: 1 });
  useLayoutEffect(() => {
    const update = () => {
      const w = outer.current.clientWidth, h = outer.current.clientHeight;
      if (!w || !h) return;
      // Geometry depends only on the card, never on the latest telemetry text.
      // Changing copy fits inside dedicated slots instead of moving the canvas.
      const scale = Math.min(1, w / (metric ? 300 : 460), h / (metric ? 200 : phase ? 460 : 280));
      const width = w / scale, height = h / scale;
      setBox(old => old.width === width && old.height === height && Math.abs(old.scale - scale) < .001 ? old : { width, height, scale });
    };
    const observer = new ResizeObserver(update);
    observer.observe(outer.current);
    update();
    return () => observer.disconnect();
  }, [metric, phase]);
  return <div ref={outer} className="telemetry-fit-outer">
    <div ref={inner} className="telemetry-fit-body" style={{ width: box.width, height: box.height, transform: `scale(${box.scale})` }}>{children}</div>
  </div>;
}

export default function ViewportTelemetryGrid({ children, enabled, selected, onSelect, hiddenItems = [], onHide }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640);
  useEffect(() => { const resize = () => setNarrow(window.innerWidth < 640); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const [saved, setSaved] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE)) || {}; } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(saved)); } catch {} }, [saved]);
  useEffect(() => { const reset = () => setSaved({}); window.addEventListener("telemetry-layout-reset", reset); return () => window.removeEventListener("telemetry-layout-reset", reset); }, []);
  if (!enabled) return <div className="flex flex-col gap-6">{children}</div>;
  const items = flatten(children).flatMap(child => {
    if (child.props.id === 'vitals') return flatten(child.props.children.props.children).map(card => ({
      id: `metric:${card.props.telemetryId || card.props.label}`, label: card.props.label, content: card, cols: narrow ? 6 : 3, rows: 2, metric: true,
    }));
    if (!child.props.id) return [];
    return [{ id: child.props.id, label: child.props.label, content: child.props.children, cols: narrow ? 12 : 6, rows: child.props.id === 'phase' ? 4 : 3 }];
  }).filter(item => !hiddenItems.includes(item.id)).sort((a,b) => (saved[a.id]?.order ?? 100) - (saved[b.id]?.order ?? 100));
  const packed = packTelemetry(items.map(item => ({ ...item, ...saved[item.id] })));
  const update = (id, patch) => setSaved(old => ({ ...old, [id]: { ...old[id], ...patch } }));
  const reorder = (id, target) => {
    const next = [...items], from = next.findIndex(i => i.id === id), to = next.findIndex(i => i.id === target);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    setSaved(old => ({ ...old, ...Object.fromEntries(next.map((item, order) => [item.id, { ...old[item.id], order }])) }));
  };
  return <div data-testid="viewport-telemetry-grid" className="telemetry-viewport-grid" style={{ gridTemplateRows: `repeat(${packed.rows}, minmax(0, 1fr))` }}>
    {items.map((item, index) => <EditableTelemetryPanel key={item.id} id={item.id} label={item.label}
      layout={packed.placements[index]} placement={packed.placements[index]} fit selected={selected === item.id} onSelect={onSelect}
      onHide={onHide ? () => { onHide(item.id); onSelect(''); } : undefined}
      onResize={size => update(item.id, size)} onMove={delta => reorder(item.id, items[index + delta]?.id)}
      onReorder={target => reorder(item.id, target)} onReset={() => update(item.id, { cols: item.cols, rows: item.rows })}>
      <FitContents metric={item.metric} phase={item.id === 'phase'}>{item.content}</FitContents>
    </EditableTelemetryPanel>)}
  </div>;
}
