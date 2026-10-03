import { Fragment, useRef, useState } from 'react';
import { DEFAULT_VIDEO_VIEW } from '../lib/videoViewport.js';

export default function StackedVideoViews({ master, secondary, masterRef, secondaryRefs, views, selected, onSelect, onReady, onReset, layout = "stacked" }) {
  const feeds = [master, secondary].filter(Boolean);
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const [ratios, setRatios] = useState({ stacked: 50, split: 50 });
  const split = layout === 'split';
  const ratio = ratios[layout] ?? 50;
  const resize = value => setRatios(previous => ({ ...previous, [layout]: Math.max(15, Math.min(85, value)) }));
  const tracks = feeds.length === 2 ? `minmax(0,${ratio}fr) 12px minmax(0,${100-ratio}fr)` : 'minmax(0,1fr)';
  const focusPanel=(event,key)=>{event.currentTarget.closest('[data-camera]').focus({preventScroll:true});onSelect(key);};
  return <div ref={containerRef} className="grid h-full min-h-0 w-full" style={{gridTemplateRows:split?'minmax(0,1fr)':tracks,gridTemplateColumns:split?tracks:'minmax(0,1fr)'}}>
    {feeds.map((feed,index)=>{
      const view=views[feed.key] || DEFAULT_VIDEO_VIEW;
      return <Fragment key={feed.key}><div data-camera={feed.key} tabIndex={0} role="group" aria-label={`${feed.label} video panel`}
        onFocus={event=>{if(event.target===event.currentTarget)onSelect(feed.key);}}
        title="Click to focus: arrows pan when zoomed. Escape releases focus. Ctrl+Left/Right seeks 5 seconds."
        className="relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-black outline-none focus:ring-2 focus:ring-inset focus:ring-primary">
        <video ref={index===0?masterRef:el=>{secondaryRefs.current[feed.key]=el;}} src={feed.src}
          muted={index!==0} playsInline preload="auto" className="h-full w-full object-fill"
          style={{transform:`translate(${view.x}%, ${view.y}%) scale(${view.zoom})`,transformOrigin:'center'}}
          onLoadedMetadata={index===0?undefined:()=>onReady(feed.key)} onClick={event=>focusPanel(event,feed.key)} />
        <button type="button" onClick={event=>focusPanel(event,feed.key)} className="absolute left-2 top-2 rounded bg-black/80 px-2 py-1 text-sm text-white">
          {feed.label} · {index===0?'Master':'Second angle'}{selected===feed.key?' · Selected':''}
        </button>
        {view.zoom>1 && <button type="button" onClick={()=>onReset(feed.key)} className="absolute right-2 bottom-2 rounded bg-black/80 px-2 py-1 text-sm text-white">{Math.round(view.zoom*100)}% · Reset zoom</button>}
      </div>
      {index === 0 && feeds.length === 2 && <div role="separator" tabIndex={0} aria-label="Resize video panels"
        aria-orientation={split ? 'vertical' : 'horizontal'} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(ratio)}
        title="Drag to resize videos. Double-click to split equally. Arrow keys resize."
        className="flex items-center justify-center rounded bg-white/10 hover:bg-primary/50 focus:bg-primary/50 outline-none"
        style={{ cursor: split ? 'col-resize' : 'row-resize', touchAction: 'none', userSelect: 'none' }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = containerRef.current.getBoundingClientRect();
          dragRef.current = { start: split ? event.clientX : event.clientY, size: (split ? rect.width : rect.height) - 12, ratio };
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (drag && drag.size > 0) resize(drag.ratio + ((split ? event.clientX : event.clientY) - drag.start) / drag.size * 100);
        }}
        onPointerUp={event => { dragRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { dragRef.current = null; }} onLostPointerCapture={() => { dragRef.current = null; }}
        onDoubleClick={() => resize(50)}
        onKeyDown={event => {
          event.stopPropagation();
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            resize(event.key === 'Home' ? 15 : event.key === 'End' ? 85 : ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -2 : 2));
          }
        }}>
        <span aria-hidden="true" className="rounded bg-white/60" style={{ width: split ? 3 : 36, height: split ? 36 : 3 }} />
      </div>}
      </Fragment>;
    })}
  </div>;
}
