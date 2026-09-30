import { DEFAULT_VIDEO_VIEW } from '../lib/videoViewport.js';

export default function StackedVideoViews({ master, secondary, masterRef, secondaryRefs, views, selected, onSelect, onReady, onReset, layout = "stacked" }) {
  const feeds = [master, secondary].filter(Boolean);
  const tracks=feeds.map(()=>'minmax(0,1fr)').join(' ');
  const focusPanel=(event,key)=>{event.currentTarget.closest('[data-camera]').focus({preventScroll:true});onSelect(key);};
  return <div className="grid h-full min-h-0 w-full gap-1" style={{gridTemplateRows:layout==='split'?'minmax(0,1fr)':tracks,gridTemplateColumns:layout==='split'?tracks:'minmax(0,1fr)'}}>
    {feeds.map((feed,index)=>{
      const view=views[feed.key] || DEFAULT_VIDEO_VIEW;
      return <div key={feed.key} data-camera={feed.key} tabIndex={0} role="group" aria-label={`${feed.label} video panel`}
        onFocus={event=>{if(event.target===event.currentTarget)onSelect(feed.key);}}
        title="Click to focus: arrows pan when zoomed. Escape releases focus. Ctrl+Left/Right seeks 5 seconds."
        className="relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-black outline-none focus:ring-2 focus:ring-inset focus:ring-primary">
        <video ref={index===0?masterRef:el=>{secondaryRefs.current[feed.key]=el;}} src={feed.src}
          muted={index!==0} playsInline preload="auto" className="h-full w-full object-contain"
          style={{transform:`translate(${view.x}%, ${view.y}%) scale(${view.zoom})`,transformOrigin:'center'}}
          onLoadedMetadata={index===0?undefined:()=>onReady(feed.key)} onClick={event=>focusPanel(event,feed.key)} />
        <button type="button" onClick={event=>focusPanel(event,feed.key)} className="absolute left-2 top-2 rounded bg-black/80 px-2 py-1 text-sm text-white">
          {feed.label} · {index===0?'Master':'Second angle'}{selected===feed.key?' · Selected':''}
        </button>
        {view.zoom>1 && <button type="button" onClick={()=>onReset(feed.key)} className="absolute right-2 bottom-2 rounded bg-black/80 px-2 py-1 text-sm text-white">{Math.round(view.zoom*100)}% · Reset zoom</button>}
      </div>;
    })}
  </div>;
}
