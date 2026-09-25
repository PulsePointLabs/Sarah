import { Children, Fragment, isValidElement, useEffect, useState } from 'react';
import EditableTelemetryPanel from './EditableTelemetryPanel';
const key = 'pulsepoint.telemetryVitalCards.v1';
function flatten(children) {
  return Children.toArray(children).flatMap((child) => isValidElement(child) && child.type === Fragment ? flatten(child.props.children) : isValidElement(child) ? [child] : []);
}
export default function EditableVitalCards({ children, selected, onSelect }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640);
  useEffect(() => { const resize = () => setNarrow(window.innerWidth < 640); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const defaultCols = narrow ? 6 : 4;
  const [saved, setSaved] = useState(() => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(saved)); } catch {} }, [saved]);
  const cards = flatten(children).map((child, index) => ({ child, id: child.props.label || `metric-${index}`, index }))
    .sort((a, b) => (saved[a.id]?.order ?? a.index) - (saved[b.id]?.order ?? b.index));
  const reorder = (id, target) => {
    const from = cards.findIndex((c) => c.id === id), to = cards.findIndex((c) => c.id === target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...cards]; next.splice(to, 0, next.splice(from, 1)[0]);
    setSaved((old) => ({ ...old, ...Object.fromEntries(next.map((c, i) => [c.id, { ...old[c.id], order: i }])) }));
  };
  return <div className="grid h-full min-h-0 grid-cols-12 gap-2 overflow-auto p-1" style={{ gridAutoRows: '80px' }}>
    {cards.map(({ child, id }, i) => <EditableTelemetryPanel key={id} id={id} label={id} order={i}
      layout={{ cols: Math.max(3, Math.min(12, Number(saved[id]?.cols) || defaultCols)), rows: Math.max(1, Math.min(8, Number(saved[id]?.rows) || 2)) }}
      selected={selected === `metric:${id}`} onSelect={(value) => onSelect(value ? `metric:${value}` : '')}
      onResize={(size) => setSaved((old) => ({ ...old, [id]: { ...old[id], ...size } }))}
      onReset={() => setSaved((old) => ({ ...old, [id]: { ...old[id], cols: defaultCols, rows: 2 } }))}
      onMove={(direction) => reorder(id, cards[i + direction]?.id)} onReorder={(target) => reorder(id, target)}>{child}</EditableTelemetryPanel>)}
  </div>;
}
