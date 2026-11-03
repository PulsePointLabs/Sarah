import { Children, Fragment, isValidElement, useLayoutEffect, useRef, useState, useEffect } from 'react';
import EditableTelemetryPanel from './EditableTelemetryPanel';
import { packTelemetry, telemetryPositionFree } from '@/lib/telemetryPacking';
import './viewportTelemetry.css';

const STORAGE = 'pulsepoint.telemetryViewport.v1';
function flatten(children) {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment || child.props.className === 'contents') return flatten(child.props.children);
    return [child];
  });
}

function FitContents({ children }) {
  return <div className="telemetry-fit-outer"><div className="telemetry-fit-body">{children}</div></div>;
}

export default function ViewportTelemetryGrid({ children, enabled, selected, onSelect, hiddenItems = [], onHide }) {
  const viewport = useRef(null);
  const [height,setHeight] = useState(720);
  useLayoutEffect(()=>{if(!enabled || !viewport.current)return;const observer=new ResizeObserver(([entry])=>setHeight(entry.contentRect.height));observer.observe(viewport.current);return()=>observer.disconnect();},[enabled]);
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
    return [{ id: child.props.id, label: child.props.label, content: child.props.children, cols: narrow ? 12 : 6, rows: child.props.id==='civet'?6:child.props.id==='phase'?5:3 }];
  }).filter(item => !hiddenItems.includes(item.id)).sort((a,b) => (saved[a.id]?.order ?? 100) - (saved[b.id]?.order ?? 100));
  const packed = packTelemetry(items.map(item => ({ ...item, ...saved[item.id], rows:Math.max(item.id==='civet'?6:item.id==='phase'?5:item.metric?2:3,saved[item.id]?.rows || item.rows) })));
  const update = (id, patch) => setSaved(old => ({ ...old, [id]: { ...old[id], ...patch } }));
  const reorder = (id, target) => {
    const next = [...items], from = next.findIndex(i => i.id === id), to = next.findIndex(i => i.id === target);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    setSaved(old => ({ ...old, ...Object.fromEntries(next.map((item, order) => [item.id, { ...old[item.id], order, x:undefined, y:undefined }])) }));
  };
  return <div ref={viewport} className="telemetry-viewport-scroll"><div data-testid="viewport-telemetry-grid" className="telemetry-viewport-grid" style={{height:Math.max(height,packed.rows*72+4*(packed.rows-1)+6),gridTemplateRows:`repeat(${packed.rows},minmax(0,1fr))`}}>
    {items.map((item, index) => <EditableTelemetryPanel key={item.id} id={item.id} label={item.label}
      layout={packed.placements[index]} placement={packed.placements[index]} fit selected={selected === item.id} onSelect={onSelect}
      onHide={onHide ? () => { onHide(item.id); onSelect(''); } : undefined}
      onResize={size => update(item.id, size)} onMove={delta => reorder(item.id, items[index + delta]?.id)}
      onReposition={position=>{const candidate={...packed.placements[index],...position};if(telemetryPositionFree(candidate,packed.placements,packed.rows))setSaved(previous=>({...previous,...Object.fromEntries(packed.placements.map(placement=>[placement.id,{...previous[placement.id],...placement,...(placement.id===item.id?position:{})}]))}));}}
      minRows={item.id==='civet'?6:item.id==='phase'?5:item.metric?2:3}
      onReorder={target => reorder(item.id, target)} onReset={() => update(item.id, { cols: item.cols, rows: item.rows })}>
      {item.id === 'civet' ? item.content : <FitContents metric={item.metric} phase={item.id === 'phase'}>{item.content}</FitContents>}
    </EditableTelemetryPanel>)}
  </div></div>;
}
