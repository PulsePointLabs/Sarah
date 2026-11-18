import {Children,Fragment,isValidElement,useLayoutEffect,useRef,useState,useEffect} from 'react';
import {createPortal} from 'react-dom';
import {tileTelemetry,reorderTile} from '@/lib/telemetryTiles.js';
import './viewportTelemetry.css';
const STORAGE='pulsepoint.telemetryTiles.v3';
function flatten(children){return Children.toArray(children).flatMap(child=>!isValidElement(child)?[]:child.type===Fragment||child.props.className==='contents'?flatten(child.props.children):[child]);}

function Tile({item,editing,resizing,onResizeSelect,onSelect,onResize,onDrop,onHide,children}){
  const root=useRef(null),frame=useRef(null),gesture=useRef(null),pointers=useRef(new Map()),wheel=useRef(null),wheelSum=useRef(0);
  const [drag,setDrag]=useState(null),[expanded,setExpanded]=useState(false);
  const base=()=>({x:item.widthWeight||item.weight||1,y:item.heightWeight||item.weight||1});
  const bound=value=>Math.max(.3,Math.min(6,value));
  wheel.current=e=>{
    if(!editing)return;e.preventDefault();
    const scale=e.deltaMode===1?20:e.deltaMode===2?root.current.clientHeight:1,dx=e.deltaX*scale,dy=e.deltaY*scale;
    if(resizing||e.ctrlKey){const w=base(),factor=Math.exp(-Math.max(-100,Math.min(100,Math.abs(dx)>Math.abs(dy)?dx:dy))/250);onResize(e.ctrlKey?{widthWeight:bound(w.x*factor),heightWeight:bound(w.y*factor)}:e.shiftKey||Math.abs(dx)>Math.abs(dy)?{widthWeight:bound(w.x*factor)}:{heightWeight:bound(w.y*factor)});}
    else {wheelSum.current+=Math.abs(dx)>Math.abs(dy)?dx:dy;if(Math.abs(wheelSum.current)>65){onDrop(null,Math.sign(wheelSum.current));wheelSum.current=0;}}
  };
  useEffect(()=>{const el=root.current,handler=e=>wheel.current(e);el.addEventListener('wheel',handler,{passive:false});return()=>el.removeEventListener('wheel',handler);},[]);
  const center=()=>{const a=[...pointers.current.values()];return {x:a.reduce((n,p)=>n+p.x,0)/a.length,y:a.reduce((n,p)=>n+p.y,0)/a.length,d:a.length>1?Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y):0};};
  const begin=(e,resize=false)=>{
    if(!editing||(!resize&&e.target.closest('button,input,select,a,textarea')))return;
    e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const c=center();gesture.current={x:c.x,y:c.y,d:c.d,dual:pointers.current.size>1,resize,weights:base(),width:item.width,height:item.height,last:c};onSelect?.(item.id);
  };
  const applyMove=()=>{
    const g=gesture.current;if(!g||!pointers.current.size)return;
    const c=center(),dx=c.x-g.x,dy=c.y-g.y;g.last=c;
    if(g.dual&&Math.abs(c.d-g.d)>10){g.pinched=true;const factor=c.d/Math.max(20,g.d);onResize({widthWeight:bound(g.weights.x*factor),heightWeight:bound(g.weights.y*factor)});}
    else if(g.resize)onResize({widthWeight:bound(g.weights.x*Math.exp(dx/Math.max(80,g.width))),heightWeight:bound(g.weights.y*Math.exp(dy/Math.max(80,g.height)))});
    else if(!g.pinched)setDrag({x:dx,y:dy});
  };
  const move=e=>{if(!gesture.current)return;pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});cancelAnimationFrame(frame.current);frame.current=requestAnimationFrame(applyMove);};
  const end=(e,cancelled=false)=>{
    cancelAnimationFrame(frame.current);applyMove();const g=gesture.current;if(!g)return;
    if(!cancelled&&g.resize&&Math.hypot(g.last.x-g.x,g.last.y-g.y)<10)onResizeSelect(item.id);
    if(!cancelled&&!g.resize&&!g.pinched&&Math.hypot(g.last.x-g.x,g.last.y-g.y)>10)onDrop(g.last.x,g.last.y);
    pointers.current.clear();gesture.current=null;setDrag(null);
  };
  const adjust=(axis,factor)=>{const w=base();onResize({[axis==='width'?'widthWeight':'heightWeight']:bound((axis==='width'?w.x:w.y)*factor)});};
  const chart=['cardiac','threshold','emg','respiratory'].includes(item.id);
  return <section ref={root} tabIndex={editing?0:undefined} aria-label={item.label} data-telemetry-item={item.id}
    className={`telemetry-tile ${editing?'telemetry-tile-editing':''} ${drag?'telemetry-tile-dragging':''}`}
    onPointerDown={e=>begin(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={e=>end(e,true)}
    onKeyDown={e=>{if(!editing||e.target!==e.currentTarget)return;if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();onDrop(null,-1);}if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();onDrop(null,1);}}}
    style={{left:item.x,top:item.y,width:item.width,height:item.height,'--tile-font':`${Math.max(10,Math.min(22,item.width/24,item.height/9))}px`,...(drag?{transform:`translate(${drag.x}px,${drag.y}px)`,zIndex:100,pointerEvents:'none'}:{})}}>
    <div className="telemetry-fit-outer"><div className="telemetry-fit-body">{children}</div></div>
    {editing&&<><div className="telemetry-tile-grip" aria-hidden="true">⠿ {item.label}</div>
      {onHide&&<button className="telemetry-tile-hide" aria-label={`Hide ${item.label}`} onClick={onHide}>×</button>}
      <button className="telemetry-tile-resize" aria-pressed={resizing} aria-label={`Resize ${item.label}`} onClick={()=>onResizeSelect(item.id)} onPointerDown={e=>begin(e,true)}>↘</button></>}
    {!editing&&chart&&<button className="telemetry-chart-expand" aria-label={`Expand ${item.label}`} onClick={()=>setExpanded(true)}>⤢</button>}
    {expanded&&createPortal(<div className="telemetry-chart-modal"><button onClick={()=>setExpanded(false)}>Close {item.label}</button><div className="telemetry-fit-body">{children}</div></div>,document.fullscreenElement||document.body)}
    {editing&&resizing&&createPortal(<div className="telemetry-resize-tools" role="toolbar" aria-label={`Resize ${item.label} controls`}>
      <b>{item.label}</b><button disabled={item.width>=item.viewportWidth-2} onClick={()=>adjust('width',1.3)}>Wider</button><button onClick={()=>adjust('width',1/1.3)}>Narrower</button><button onClick={()=>adjust('height',1.3)}>Taller</button><button onClick={()=>adjust('height',1/1.3)}>Shorter</button><button onClick={()=>onResizeSelect('')}>Done resizing</button>
      <small>Tap buttons, drag the corner, or use two fingers: pinch to resize; slide to move.</small>
    </div>,document.fullscreenElement||document.body)}
  </section>;
}

export default function ViewportTelemetryGrid({children,enabled,onSelect,hiddenItems=[],onHide,immersive=false}){
  const viewport=useRef(null),[size,setSize]=useState({width:1200,height:700}),[editing,setEditing]=useState(false),[resizeId,setResizeId]=useState('');
  const [saved,setSaved]=useState(()=>{try{return JSON.parse(localStorage.getItem(STORAGE))||{};}catch{return {};}});
  useEffect(()=>{try{localStorage.setItem(STORAGE,JSON.stringify(saved));}catch{}},[saved]);
  useEffect(()=>{const reset=()=>setSaved({});window.addEventListener('telemetry-layout-reset',reset);return()=>window.removeEventListener('telemetry-layout-reset',reset);},[]);
  useLayoutEffect(()=>{if(!enabled||!viewport.current)return;const observer=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(viewport.current);return()=>observer.disconnect();},[enabled]);
  useEffect(()=>{if(immersive){setEditing(false);setResizeId('');}},[immersive]);
  if(!enabled)return <div className="flex flex-col gap-6">{children}</div>;
  const items=flatten(children).flatMap(child=>child.props.id==='vitals'?flatten(child.props.children.props.children).map(card=>({id:`metric:${card.props.telemetryId||card.props.label}`,label:card.props.label,content:card,weight:1,kind:'metric'})):child.props.id?[{id:child.props.id,label:child.props.label,content:child.props.children,weight:['civet','phase','cardiac'].includes(child.props.id)?2:1.5}]:[])
    .filter(item=>!hiddenItems.includes(item.id)).map((item,index)=>({...item,...saved[item.id],weight:saved[item.id]?.weight||item.weight,defaultOrder:item.kind==='metric'?index:index+100})).sort((a,b)=>(saved[a.id]?.order??a.defaultOrder)-(saved[b.id]?.order??b.defaultOrder));
  const placements=tileTelemetry(items,size.width,size.height);
  const reorder=(id,target)=>setSaved(old=>({...old,...Object.fromEntries(reorderTile(items,id,target).map((item,order)=>[item.id,{...old[item.id],order}]))}));
  const drop=(id,x,y)=>{
    const index=items.findIndex(item=>item.id===id);if(x===null){reorder(id,items[index+y]?.id);return;}
    const box=viewport.current.getBoundingClientRect(),px=x-box.left,py=y-box.top;
    const target=placements.filter(item=>item.id!==id).sort((a,b)=>Math.hypot(px-a.x-a.width/2,py-a.y-a.height/2)-Math.hypot(px-b.x-b.width/2,py-b.y-b.height/2))[0];
    if(target)reorder(id,target.id);
  };
  return <div className="telemetry-workspace"><div className="telemetry-layout-bar" hidden={immersive}>
    <button type="button" aria-pressed={editing} onClick={()=>{setEditing(v=>!v);onSelect?.('');}}>{editing?'Done':'Edit layout'}</button>
    <span>{editing?'Drag a card · tap ↘ for resize buttons · two-finger slide/pinch supported':'Cards fill the screen · layout saved on this device'}</span>
    {editing&&<button type="button" onClick={()=>setSaved({})}>Reset layout</button>}</div>
    <div ref={viewport} data-testid="viewport-telemetry-grid" className="telemetry-viewport-grid" data-editing={editing}>
      {placements.map(item=><Tile key={item.id} item={item} editing={editing} resizing={resizeId===item.id} onResizeSelect={setResizeId} onSelect={onSelect}
        onResize={patch=>setSaved(old=>({...old,[item.id]:{...old[item.id],...patch}}))} onDrop={(x,y)=>drop(item.id,x,y)} onHide={onHide?()=>onHide(item.id):undefined}>{item.content}</Tile>)}
      {!items.length&&<p className="p-4">Choose a telemetry preset or enable cards in Controls.</p>}
    </div></div>;
}
