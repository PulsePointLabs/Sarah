import {Children,isValidElement,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {tileTelemetry,reorderTile} from '../lib/telemetryTiles.js';
import TelemetryPickerMenu from './TelemetryPickerMenu.jsx';
import {VideoOverlayPreferenceScope} from './VideoOverlayPreferences.jsx';
import './monitorTelemetryDashboard.css';

const STORAGE='sarah.videoSync.dashboard.v1';
const accent=id=>id==='cardiac'?'#34e37e':id==='autonomic'?'#ffd43b':id==='civet'?'#55e4ce':id==='howl'?'#b794ff':'#8ca3b8';
function read(){try{return JSON.parse(localStorage.getItem(STORAGE))||{};}catch{return {};}}
function MonitorTile({item,editing,onCommit,onPreview,onHide,children}){
  const node=useRef(null),dialog=useRef(null),gesture=useRef(null),pointers=useRef(new Map()),frame=useRef(0),wheelTimer=useRef(null),latest=useRef(null);
  const [draft,setDraft]=useState(null),[expanded,setExpanded]=useState(false);
  useEffect(()=>{if(expanded)dialog.current?.showModal();},[expanded]);
  const begin=(event,resize=false)=>{
    if(event.button!==0)return;
    event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);
    const dual=pointers.current.size===2,points=[...pointers.current.values()];
    gesture.current={x:dual?points.reduce((s,p)=>s+p.x,0)/2:event.clientX,y:dual?points.reduce((s,p)=>s+p.y,0)/2:event.clientY,dual,box:{...item},resize,dx:0,dy:0};
  };
  const preview=(dx,dy)=>{
    const g=gesture.current;if(!g||Math.hypot(dx,dy)<6)return;
    g.dx=dx;g.dy=dy;
    const next=g.resize?{width:Math.max(180,g.box.width+dx),height:Math.max(120,g.box.height+dy)}:{transform:`translate(${dx}px,${dy}px)`};
    cancelAnimationFrame(frame.current);frame.current=requestAnimationFrame(()=>{setDraft(next);onPreview(item.id,g.box.x+g.box.width/2+dx,g.box.y+g.box.height/2+dy,!g.resize);});
  };
  const finish=cancelled=>{
    const g=gesture.current;cancelAnimationFrame(frame.current);gesture.current=null;pointers.current.clear();setDraft(null);
    if(g&&!cancelled&&Math.hypot(g.dx,g.dy)>=6)onCommit(item.id,g);onPreview(null);
  };
  latest.current={item,preview,finish};
  useLayoutEffect(()=>{
    const el=node.current,handler=event=>{
      const {item,preview,finish}=latest.current;
      if(!editing||event.target.closest('input,select,textarea'))return;
      event.preventDefault();
      if(!gesture.current)gesture.current={x:0,y:0,box:{...item},dx:0,dy:0,resize:event.ctrlKey};
      const g=gesture.current;preview(g.dx+event.deltaX,g.dy+event.deltaY);
      clearTimeout(wheelTimer.current);wheelTimer.current=setTimeout(()=>finish(false),220);
    };
    el.addEventListener('wheel',handler,{passive:false});return()=>{el.removeEventListener('wheel',handler);clearTimeout(wheelTimer.current);cancelAnimationFrame(frame.current);};
  },[editing]);
  const box={left:item.x+3,top:item.y+3,width:Math.max(1,item.width-6),height:Math.max(1,item.height-6),...draft};
  return <section ref={node} className={`monitor-tile ${draft?'is-moving':''}`} data-video-section={item.id} data-monitor-section={item.id} data-compact={item.height<260||item.width<360} style={{...box,'--monitor-accent':accent(item.id),'--monitor-value':`${Math.max(28,Math.min(140,item.height*.48,item.width*(item.id.includes('Blood Pressure')?.17:.29)))}px`}}
    onPointerDown={event=>{if(!editing||event.pointerType!=='touch'||event.target.closest('button,input,select,textarea'))return;pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.current.size===2)begin(event);}}
    onPointerMove={event=>{const g=gesture.current;if(!g)return;if(pointers.current.has(event.pointerId))pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});const points=[...pointers.current.values()],x=g.dual?points.reduce((s,p)=>s+p.x,0)/points.length:event.clientX,y=g.dual?points.reduce((s,p)=>s+p.y,0)/points.length:event.clientY;preview(x-g.x,y-g.y);}}
    onPointerUp={()=>finish(false)} onPointerCancel={()=>finish(true)}>
    <header className="monitor-tile-heading"><button aria-label={`Move ${item.label}`} disabled={!editing} onPointerDown={event=>begin(event)} onKeyDown={event=>{if(!editing||!event.key.startsWith('Arrow'))return;event.preventDefault();event.stopPropagation();onCommit(item.id,{step:['ArrowLeft','ArrowUp'].includes(event.key)?-1:1});}}>⠿ {item.label}</button><button aria-label={`Expand ${item.label}`} onClick={()=>setExpanded(true)}>⤢</button>{editing&&<button aria-label={`Hide ${item.label}`} onClick={onHide}>×</button>}</header>
    <VideoOverlayPreferenceScope.Provider value={`dashboard-${item.id}`}><div className="monitor-tile-body">{children}</div>
    {expanded&&createPortal(<dialog ref={dialog} className="monitor-expanded" aria-label={`${item.label} expanded`} onCancel={()=>setExpanded(false)}><header><b>{item.label}</b><button autoFocus onClick={()=>setExpanded(false)}>Close expanded card</button></header><div className="monitor-tile-body">{children}</div></dialog>,node.current.ownerDocument.fullscreenElement||node.current.ownerDocument.body)}</VideoOverlayPreferenceScope.Provider>
    {editing&&<button className="monitor-tile-resize" aria-label={`Resize ${item.label}`} onPointerDown={event=>begin(event,true)} onKeyDown={event=>{if(!event.key.startsWith('Arrow'))return;event.preventDefault();event.stopPropagation();onCommit(item.id,{weights:{[event.key.includes('Left')||event.key.includes('Right')?'widthWeight':'heightWeight']:(item[event.key.includes('Left')||event.key.includes('Right')?'widthWeight':'heightWeight']||1)*(['ArrowLeft','ArrowUp'].includes(event.key)?.9:1.1)}});}}>◢</button>}
  </section>;
}
export default function MonitorTelemetryDashboard({children,dashboard}){
  const viewport=useRef(null),[size,setSize]=useState({width:800,height:700}),[saved,setSaved]=useState(read),[editing,setEditing]=useState(false),[target,setTarget]=useState(null);
  const save=next=>{setSaved(next);try{localStorage.setItem(STORAGE,JSON.stringify(next));}catch{}};
  useLayoutEffect(()=>{const el=viewport.current,win=el.ownerDocument.defaultView;const measure=()=>{const r=el.getBoundingClientRect();if(r.width>0&&r.height>0)setSize(old=>old.width===r.width&&old.height===r.height?old:{width:r.width,height:r.height});};const observer=new win.ResizeObserver(measure);observer.observe(el);win.addEventListener('resize',measure);el.ownerDocument.addEventListener('fullscreenchange',measure);measure();return()=>{observer.disconnect();win.removeEventListener('resize',measure);el.ownerDocument.removeEventListener('fullscreenchange',measure);};},[]);
  const sections=Children.toArray(children.props.children).filter(child=>isValidElement(child)&&child.props['data-sidebar-section']);
  const items=sections.flatMap(child=>{const [id,label]=child.props['data-sidebar-section'];return id==='metrics'?Children.toArray(child.props.children).filter(isValidElement).map(card=>({id:`metric:${card.props.label}`,label:card.props.label,child:card,kind:'metric',weight:.5})):[{id,label,child,weight:id==='civet'?1.4:1}];});
  const visible=items.filter(item=>!saved[item.id]?.hidden).map((item,index)=>({...item,...saved[item.id],order:saved[item.id]?.order??index})).sort((a,b)=>a.order-b.order);
  const placements=tileTelemetry(visible,size.width,size.height);
  const nearest=(x,y,id)=>placements.filter(item=>item.id!==id).sort((a,b)=>Math.hypot(x-a.x-a.width/2,y-a.y-a.height/2)-Math.hypot(x-b.x-b.width/2,y-b.y-b.height/2))[0];
  const commit=(id,g)=>{
    if(g.resize||g.weights){const w=g.weights||{widthWeight:(g.box.widthWeight||1)*Math.max(.5,(g.box.width+g.dx)/g.box.width),heightWeight:(g.box.heightWeight||g.box.weight||1)*Math.max(.5,(g.box.height+g.dy)/g.box.height)};save({...saved,[id]:{...saved[id],...Object.fromEntries(Object.entries(w).map(([k,v])=>[k,Math.max(.4,Math.min(3,v))]))}});}
    else{const index=visible.findIndex(item=>item.id===id),to=g.step?visible[index+g.step]:nearest(g.box.x+g.box.width/2+g.dx,g.box.y+g.box.height/2+g.dy,id);if(to)save({...saved,...Object.fromEntries(reorderTile(visible,id,to.id).map((item,order)=>[item.id,{...saved[item.id],order}]))});}
  };
  return <div className={`monitor-layout ${dashboard?'monitor-layout-detached':'monitor-layout-sidebar'}`}>
    <div className="monitor-layout-tools"><button aria-pressed={editing} onClick={()=>setEditing(!editing)}>{editing?'Done arranging':'Arrange cards'}</button><TelemetryPickerMenu label="Cards" summary={`${visible.length} / ${items.length}`} options={items.map(item=>({id:item.id,label:item.label,checked:!saved[item.id]?.hidden,onChange:()=>save({...saved,[item.id]:{...saved[item.id],hidden:!saved[item.id]?.hidden}})}))}/>{editing&&<button onClick={()=>save({})}>Reset layout</button>}</div>
    <div ref={viewport} className={`monitor-layout-viewport ${editing?'is-arranging':''}`}>
      {target&&<div className="monitor-drop-target" style={{left:target.x,top:target.y,width:target.width,height:target.height}}/>}
      {placements.map(item=><MonitorTile key={item.id} item={item} editing={editing} onCommit={commit} onPreview={(id,x,y,moving)=>setTarget(id&&moving?nearest(x,y,id):null)} onHide={()=>save({...saved,[item.id]:{...saved[item.id],hidden:true}})}>{item.child}</MonitorTile>)}
    </div>
  </div>;
}
