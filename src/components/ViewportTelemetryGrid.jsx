import {Children,Fragment,isValidElement,useLayoutEffect,useRef,useState,useEffect} from 'react';
import {tileTelemetry,reorderTile} from '@/lib/telemetryTiles.js';
import './viewportTelemetry.css';
const STORAGE='pulsepoint.telemetryTiles.v2';
function flatten(children){return Children.toArray(children).flatMap(child=>!isValidElement(child)?[]:child.type===Fragment||child.props.className==='contents'?flatten(child.props.children):[child]);}

function Tile({item,editing,onSelect,onWeight,onDrop,onHide,children}){
  const gesture=useRef(null),[drag,setDrag]=useState(null);
  const begin=(e,resize=false)=>{
    if(!editing||(!resize&&e.target.closest('button,input,select,a,textarea')))return;
    e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current={x:e.clientX,y:e.clientY,resize,weight:item.weight||1,width:item.width,height:item.height};onSelect?.(item.id);
  };
  const move=e=>{
    const g=gesture.current;if(!g)return;const dx=e.clientX-g.x,dy=e.clientY-g.y;
    if(g.resize)onWeight(Math.max(.35,Math.min(5,g.weight*Math.exp(dx/Math.max(80,g.width)+dy/Math.max(80,g.height)))));
    else setDrag({x:dx,y:dy});
  };
  const end=(e,cancelled=false)=>{const g=gesture.current;if(!g)return;if(!cancelled&&!g.resize)onDrop(e.clientX,e.clientY);gesture.current=null;setDrag(null);};
  return <section tabIndex={editing?0:undefined} aria-label={item.label} data-telemetry-item={item.id}
    className={`telemetry-tile ${editing?'telemetry-tile-editing':''} ${drag?'telemetry-tile-dragging':''}`}
    onPointerDown={e=>begin(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={e=>end(e,true)}
    onKeyDown={e=>{if(!editing||e.target!==e.currentTarget)return;if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();onDrop(null,-1);}if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();onDrop(null,1);}}}
    style={{left:item.x,top:item.y,width:item.width,height:item.height,'--tile-font':`${Math.max(10,Math.min(24,item.width/22,item.height/9))}px`,...(drag?{transform:`translate(${drag.x}px,${drag.y}px)`,zIndex:100,pointerEvents:'none'}:{})}}>
    <div className="telemetry-fit-outer"><div className="telemetry-fit-body">{children}</div></div>
    {editing&&<><div className="telemetry-tile-grip" aria-hidden="true">⠿ {item.label}</div>
      {onHide&&<button className="telemetry-tile-hide" aria-label={`Hide ${item.label}`} onClick={onHide}>×</button>}
      <button className="telemetry-tile-resize" aria-label={`Resize ${item.label}`} onPointerDown={e=>begin(e,true)} onPointerMove={move} onPointerUp={end} onPointerCancel={e=>end(e,true)}>↘</button></>}
  </section>;
}

export default function ViewportTelemetryGrid({children,enabled,onSelect,hiddenItems=[],onHide}){
  const viewport=useRef(null),[size,setSize]=useState({width:1200,height:700}),[editing,setEditing]=useState(false);
  const [saved,setSaved]=useState(()=>{try{return JSON.parse(localStorage.getItem(STORAGE))||{};}catch{return {};}});
  useEffect(()=>{try{localStorage.setItem(STORAGE,JSON.stringify(saved));}catch{}},[saved]);
  useEffect(()=>{const reset=()=>setSaved({});window.addEventListener('telemetry-layout-reset',reset);return()=>window.removeEventListener('telemetry-layout-reset',reset);},[]);
  useLayoutEffect(()=>{if(!enabled||!viewport.current)return;const observer=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(viewport.current);return()=>observer.disconnect();},[enabled]);
  if(!enabled)return <div className="flex flex-col gap-6">{children}</div>;
  const items=flatten(children).flatMap(child=>child.props.id==='vitals'?flatten(child.props.children.props.children).map(card=>({id:`metric:${card.props.telemetryId||card.props.label}`,label:card.props.label,content:card,weight:1})):child.props.id?[{id:child.props.id,label:child.props.label,content:child.props.children,weight:['civet','phase','cardiac'].includes(child.props.id)?2:1.5}]:[])
    .filter(item=>!hiddenItems.includes(item.id)).map(item=>({...item,weight:saved[item.id]?.weight||item.weight})).sort((a,b)=>(saved[a.id]?.order??100)-(saved[b.id]?.order??100));
  const placements=tileTelemetry(items,size.width,size.height);
  const reorder=(id,target)=>setSaved(old=>({...old,...Object.fromEntries(reorderTile(items,id,target).map((item,order)=>[item.id,{...old[item.id],order}]))}));
  const drop=(id,x,y)=>{
    const index=items.findIndex(item=>item.id===id);if(x===null){reorder(id,items[index+y]?.id);return;}
    const box=viewport.current.getBoundingClientRect(),px=x-box.left,py=y-box.top;
    const target=placements.filter(item=>item.id!==id).sort((a,b)=>Math.hypot(px-a.x-a.width/2,py-a.y-a.height/2)-Math.hypot(px-b.x-b.width/2,py-b.y-b.height/2))[0];
    if(target)reorder(id,target.id);
  };
  return <div className="telemetry-workspace"><div className="telemetry-layout-bar">
    <button type="button" aria-pressed={editing} onClick={()=>{setEditing(v=>!v);onSelect?.('');}}>{editing?'Done':'Edit layout'}</button>
    <span>{editing?'Drag any card · pull its corner to share space':'Cards fill the screen · layout saved on this device'}</span>
    {editing&&<button type="button" onClick={()=>setSaved({})}>Reset layout</button>}</div>
    <div ref={viewport} data-testid="viewport-telemetry-grid" className="telemetry-viewport-grid" data-editing={editing}>
      {placements.map(item=><Tile key={item.id} item={item} editing={editing} onSelect={onSelect}
        onWeight={weight=>setSaved(old=>({...old,[item.id]:{...old[item.id],weight}}))} onDrop={(x,y)=>drop(item.id,x,y)} onHide={onHide?()=>onHide(item.id):undefined}>{item.content}</Tile>)}
      {!items.length&&<p className="p-4">Choose a telemetry preset or enable cards in Controls.</p>}
    </div></div>;
}
