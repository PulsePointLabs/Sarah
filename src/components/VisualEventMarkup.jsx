import {useEffect,useMemo,useRef,useState} from 'react';
import {drawVisualShapes,finalizeVisualAnnotation,imagePoint,loadVisualImage,sameVisualCamera,visualClock,visualMetricLines,visualAnnotationSignature} from '../lib/visualEventAnnotation.js';
import './visualEventMarkup.css';

const TOOLS=[['highlight','Highlight'],['ellipse','Circle / ellipse'],['rectangle','Rectangle'],['distance','Distance / width'],['angle','Angle (3 points)'],['color','Sample color'],['scale','Set scale']];
const TARGETS=['Penile length','Penile width','Scrotal lift','Scrotal width','Foot angle','Toe angle','Skin tone','Other'];
const newId=()=>globalThis.crypto?.randomUUID?.()||`mark-${Date.now()}-${Math.random()}`;

export function VisualEventSummary({annotation,onOpen,compact=false}) {
  if(!annotation?.shapes?.length)return onOpen?<button type="button" className="visual-event-open" onClick={onOpen}>Mark frame / measure</button>:null;
  return <div className="visual-event-summary">
    {onOpen&&<button type="button" className="visual-event-open" onClick={onOpen}>View / edit {annotation.shapes.length} visual marks · {annotation.camera?.label} · {visualClock(annotation.frame.session_time_s)}</button>}
    {visualMetricLines(annotation).slice(0,compact?2:undefined).map((line,i)=><div key={annotation.shapes[i].id}>{line}</div>)}
    {compact&&annotation.shapes.length>2&&<button type="button" className="visual-event-open" onClick={onOpen}>View all {annotation.shapes.length} marks and measurements</button>}
    {annotation.reference&&<div className="visual-event-reference">Compared with {visualClock(annotation.reference.session_time_s)} · same camera</div>}
    {!compact&&annotation.ai_review?.summary&&<div><strong>Sarah’s marked-frame read</strong><p>{annotation.ai_review.summary}</p>{annotation.ai_review.findings?.map((finding,i)=><p key={i}><b>{finding.label}:</b> {finding.observation}{finding.uncertainty?` · ${finding.uncertainty}`:''}</p>)}</div>}
  </div>;
}

export function VisualVideoOverlay({annotation,frameTimeS,feedKey,camera,view={zoom:1,x:0,y:0}}) {
  if(!annotation?.shapes?.length||annotation.camera?.key!==feedKey||Math.abs(Number(frameTimeS)-Number(annotation.frame.session_time_s))>.75)return null;
  if(camera&&!sameVisualCamera(annotation.camera,camera))return null;
  const {width,height}=annotation.frame;
  return <svg aria-label="Selected event visual markings" className="visual-event-video-overlay" viewBox={`0 0 ${width} ${height}`} style={{transform:`translate(${view.x}%, ${view.y}%) scale(${view.zoom})`,transformOrigin:'center'}}>
    {annotation.shapes.map((shape,index)=>{
      const ps=shape.points.map(p=>({x:p.x*width,y:p.y*height}));if(!ps.length)return null;
      const color=shape.color||'#22d3ee',a=ps[0],b=ps[1]||a;
      const box={x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(b.x-a.x),height:Math.abs(b.y-a.y)};
      const weight=Math.max(2,width/450);
      return <g key={shape.id} fill="none" stroke={color} strokeWidth={shape.type==='highlight'?weight*6:weight} strokeLinejoin="round" opacity={shape.type==='highlight'?.45:1}>
        {['rectangle','color'].includes(shape.type)?<rect {...box}/>:shape.type==='ellipse'?<ellipse cx={box.x+box.width/2} cy={box.y+box.height/2} rx={box.width/2} ry={box.height/2}/>:<polyline points={ps.map(p=>`${p.x},${p.y}`).join(' ')}/>}
        <text x={Math.max(4,Math.min(a.x,width*.8))} y={Math.max(20,a.y-8)} fill={color} stroke="black" strokeWidth={2} paintOrder="stroke" fontSize={Math.max(18,width/60)}>{index+1}. {shape.label}</text>
      </g>;
    })}
  </svg>;
}

export default function VisualEventMarkup({initial,frame,camera,events=[],eventId,onApply,onClose,onReview}) {
  const dialog=useRef(null),canvas=useRef(null),baseCanvas=useRef(null),gesture=useRef(null),angle=useRef([]);
  const [draft,setDraft]=useState(()=>initial||{version:1,frame,camera,shapes:[],calibration:null});
  const [tool,setTool]=useState('ellipse'),[target,setTarget]=useState('Other'),[label,setLabel]=useState('Region'),[color,setColor]=useState('#22d3ee');
  const [drawing,setDrawing]=useState(null),[referenceId,setReferenceId]=useState(initial?.reference?.event_id||''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [ready,setReady]=useState(false),[selected,setSelected]=useState('');
  const [aiReview,setAiReview]=useState(initial?.ai_review||null);
  const references=useMemo(()=>events.filter(event=>event.event_id!==eventId&&event.visual_annotation?.shapes?.length&&sameVisualCamera(draft.camera,event.visual_annotation.camera)),[events,eventId,draft.camera]);
  const reference=references.find(event=>event.event_id===referenceId);
  const referenceAnnotation=reference?{...reference.visual_annotation,event_id:reference.event_id}:null;
  const signature=visualAnnotationSignature({...draft,reference:{event_id:referenceId,updated_at:referenceAnnotation?.updated_at}});
  const signatureRef=useRef(signature);signatureRef.current=signature;
  const currentReview=aiReview?.signature===signature?aiReview:null;
  const referenceRef=useRef(referenceAnnotation);referenceRef.current=referenceAnnotation;
  const [measured,setMeasured]=useState(initial||null);
  useEffect(()=>{dialog.current.showModal();},[]);
  useEffect(()=>{
    let canceled=false;
    loadVisualImage(draft.frame).then(image=>{if(canceled)return;baseCanvas.current=image;setReady(true);}).catch(e=>setError(e.message));
    return()=>{canceled=true;};
  },[draft.frame]);
  useEffect(()=>{
    if(!ready||!canvas.current)return;
    const context=canvas.current.getContext('2d');context.clearRect(0,0,canvas.current.width,canvas.current.height);context.drawImage(baseCanvas.current,0,0);
    drawVisualShapes(context,{...draft,shapes:[...draft.shapes,...(drawing?[drawing]:[])]});
  },[draft,drawing,ready]);
  useEffect(()=>{
    if(!ready)return;
    let current=true;
    finalizeVisualAnnotation(draft,referenceRef.current).then(result=>{if(current)setMeasured(result);}).catch(e=>{if(current)setError(e.message);});
    return()=>{current=false;};
  },[draft,referenceId,ready]);
  const changeTool=value=>{if(busy)return;setTool(value);gesture.current=null;angle.current=[];setDrawing(null);};
  const point=event=>imagePoint(event.currentTarget.getBoundingClientRect(),draft.frame.width,draft.frame.height,event.clientX,event.clientY);
  const build=points=>({id:newId(),type:tool,label:label.trim()||target||tool,color,points});
  const add=shape=>{setDraft(previous=>({...previous,shapes:[...previous.shapes,shape]}));setSelected(shape.id);setDrawing(null);};
  const pointerDown=event=>{
    if(event.button!==0||!ready||busy)return;event.preventDefault();const p=point(event);if(!p)return;
    setError('');
    if(tool==='angle'||tool==='distance'||tool==='scale'){
      angle.current=[...angle.current,p];const shape=build(angle.current);
      if(angle.current.length===(tool==='angle'?3:2)){add(shape);if(tool==='scale')setDraft(previous=>({...previous,calibration:{shape_id:shape.id,length:'',unit:'cm'}}));angle.current=[];}
      else setDrawing(shape);
    }else{
      event.currentTarget.setPointerCapture(event.pointerId);const shape=build(tool==='highlight'?[p]:[p,p]);gesture.current=shape;setDrawing(shape);
    }
  };
  const pointerMove=event=>{
    if(!gesture.current)return;const p=point(event);if(!p)return;
    const shape=gesture.current;
    const history=shape.points.length>=249?shape.points.filter((_,i)=>i%2===0):shape.points;
    const next={...shape,points:tool==='highlight'?[...history,p]:[shape.points[0],p]};gesture.current=next;setDrawing(next);
  };
  const pointerUp=event=>{
    const shape=gesture.current;if(!shape)return;gesture.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    const [a,b]=shape.points;
    if(shape.points.length>1&&(Math.abs(a.x-b.x)+Math.abs(a.y-b.y)>.002||shape.type==='highlight'))add(shape);else setDrawing(null);
  };
  const remove=id=>{if(busy)return;setDraft(previous=>({...previous,shapes:previous.shapes.filter(s=>s.id!==id),calibration:previous.calibration?.shape_id===id?null:previous.calibration}));setSelected('');};
  const save=async()=>{
    setBusy(true);setError('');
    try{
      if(drawing)throw Error('Finish the current marking, or change tools to cancel it.');
      if(draft.calibration&&!(Number(draft.calibration.length)>0))throw Error('Enter the known scale length, or remove the scale marking.');
      const result=await finalizeVisualAnnotation(draft,referenceAnnotation);result.ai_review=currentReview||null;await onApply(result);
    }catch(e){setError(e.message||'Could not save visual markings.');}finally{setBusy(false);}
  };
  const review=async()=>{
    const requestedSignature=signature;setBusy(true);setError('');
    try{
      const measured=await finalizeVisualAnnotation(draft,referenceAnnotation);
      const result=await onReview(measured,referenceAnnotation);
      if(signatureRef.current!==requestedSignature)throw Error('The marks changed while Sarah was reviewing. Run the review again to use the updated markings.');
      setAiReview({...result,signature:requestedSignature,created_at:new Date().toISOString()});
    }catch(e){setError(e.message||'Sarah could not review these markings.');}finally{setBusy(false);}
  };
  const selectedShape=draft.shapes.find(s=>s.id===selected);
  return <dialog ref={dialog} data-anatomy-dialog className="visual-markup-editor" aria-label="Visual event annotation" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onKeyDown={event=>event.stopPropagation()}>
    <header><div><strong>Mark this event frame</strong><p>{draft.camera.label} · {visualClock(draft.frame.session_time_s)} · source {draft.frame.source_width} × {draft.frame.source_height}</p></div><button type="button" disabled={busy} onClick={onClose}>Cancel</button></header>
    <div className="visual-markup-toolbar" role="toolbar" aria-label="Drawing tools">{TOOLS.map(([id,name])=><button type="button" key={id} aria-pressed={tool===id} onClick={()=>changeTool(id)}>{name}</button>)}</div>
    <div className="visual-markup-body">
      <div className="visual-markup-stage"><canvas ref={canvas} width={draft.frame.width} height={draft.frame.height} aria-label="Event frame drawing canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{gesture.current=null;setDrawing(null);}}/></div>
      <aside>
        <p>{['angle','distance','scale'].includes(tool)?`Click ${tool==='angle'?'three points; the second is the vertex':'the two endpoints'}.`:'Drag on the image to mark the region.'}</p>
        <label>Aspect<select disabled={busy} aria-label="Aspect" value={target} onChange={event=>{setTarget(event.target.value);setLabel(event.target.value==='Other'?'Region':event.target.value);}}>{TARGETS.map(t=><option key={t}>{t}</option>)}</select></label>
        <label>Label for the next mark<input disabled={busy} aria-label="Label for the next mark" value={label} maxLength={100} onChange={event=>setLabel(event.target.value)}/></label>
        <label>Mark color<input disabled={busy} aria-label="Mark color" type="color" value={color} onChange={event=>setColor(event.target.value)}/></label>
        <label>Compare with a saved marked event<select disabled={busy} aria-label="Comparison event" value={referenceId} onChange={event=>setReferenceId(event.target.value)}><option value="">No comparison</option>{references.map(event=><option key={event.event_id} value={event.event_id}>{visualClock(event.visual_annotation.frame.session_time_s)} · {event.note?.slice(0,70)}</option>)}</select></label>
        <p>Use the same label and tool on both frames to compare. Keep the camera and pose consistent.</p>
        {referenceAnnotation&&<img className="visual-markup-reference" src={referenceAnnotation.marked_frame_data_url||referenceAnnotation.frame.data_url} alt={`Comparison frame at ${visualClock(referenceAnnotation.frame.session_time_s)}`}/>}
        {initial?.reference?.event_id===referenceId&&referenceAnnotation&&initial.reference.updated_at!==referenceAnnotation.updated_at&&<p>Reference marks have changed. Applying these marks recalculates the comparison against the updated reference.</p>}
        {initial?.reference?.event_id===referenceId&&!referenceAnnotation&&<p>The original comparison event is unavailable. Applying these marks removes that comparison; the saved event is unchanged until then.</p>}
        {draft.calibration&&<fieldset><legend>Known in-plane scale</legend><label>Length<input disabled={busy} aria-label="Known scale length" type="number" min="0.001" step="any" value={draft.calibration.length} onChange={event=>setDraft(previous=>({...previous,calibration:{...previous.calibration,length:event.target.value}}))}/></label><label>Units<select disabled={busy} value={draft.calibration.unit} onChange={event=>setDraft(previous=>({...previous,calibration:{...previous.calibration,unit:event.target.value}}))}><option>cm</option><option>mm</option><option>in</option></select></label></fieldset>}
        <div className="visual-markup-list" aria-label="Visual marks">{draft.shapes.map((shape,i)=><div key={shape.id}><button type="button" aria-pressed={selected===shape.id} onClick={()=>setSelected(shape.id)}>{i+1}. {shape.label} · {shape.type}</button><button type="button" aria-label={`Delete mark ${i+1}`} onClick={()=>remove(shape.id)}>×</button></div>)}</div>
        {selectedShape&&<label>Edit selected label<input disabled={busy} aria-label="Selected mark label" value={selectedShape.label} maxLength={100} onChange={event=>{const label=event.target.value;setDraft(previous=>({...previous,shapes:previous.shapes.map(s=>s.id===selected?{...s,label}:s)}));}}/></label>}
        <VisualEventSummary annotation={{...measured,ai_review:null}}/>
        {onReview&&<button type="button" disabled={busy||!ready||!draft.shapes.length||Boolean(drawing)} onClick={review}>Ask Sarah about these marks</button>}
        {currentReview&&<section aria-label="Sarah marked-frame review"><strong>Sarah’s marked-frame read</strong><p>{currentReview.summary}</p>{currentReview.findings?.map((finding,i)=><p key={i}><b>{finding.label}:</b> {finding.observation}{finding.uncertainty?` · ${finding.uncertainty}`:''}</p>)}</section>}
        <p>Sarah’s visual review uses these labeled frames and measurements with the analysis provider when you run a review.</p>
        {referenceAnnotation&&measured&&!measured.comparisons?.length&&<p>No matching measurable labels yet.</p>}
      </aside>
    </div>
    <footer><p>Distances are image-plane estimates. Width is not girth. Color comparisons depend on lighting and camera exposure.</p>{error&&<p role="alert">{error}</p>}<div><button type="button" disabled={!draft.shapes.length||busy} onClick={()=>remove(draft.shapes.at(-1).id)}>Undo last mark</button><button type="button" disabled={!ready||busy||Boolean(drawing)} onClick={save}>{busy?'Saving…':'Use these marks'}</button></div></footer>
  </dialog>;
}
