import {useState} from 'react';
import './videoReviewDisplayControls.css';

export default function VideoReviewDisplayControls({controller,onRestore,onExit}){
  const [open,setOpen]=useState(false);
  return <div className="review-display-controls" data-review-display-controls onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.stopPropagation();}else if(open)e.stopPropagation();}}>
    <button aria-expanded={open} onClick={()=>setOpen(!open)}>Display</button>
    {open&&<div className="review-display-menu" role="group" aria-label="Review display controls">
      <button onClick={()=>{onRestore();setOpen(false);}}>Show sidebar and controls</button>
      <button onClick={()=>{controller.setEditing(!controller.editing);controller.setVisible(true);setOpen(false);}}>{controller.editing?'Done arranging overlays':'Arrange overlays'}</button>
      <button onClick={()=>controller.setVisible(controller.options.hidden)}>{controller.options.hidden?'Show overlays':'Hide overlays'}</button>
      <button onClick={()=>{controller.resetPositions();controller.setVisible(true);setOpen(false);}}>Compact overlay positions</button>
      <button onClick={()=>{onExit();setOpen(false);}}>Exit full telemetry</button>
    </div>}
  </div>;
}
