import {cloneElement,createContext,useContext,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {DefaultTooltipContent} from 'recharts';
const ChartDocument=createContext(null);

export function DocumentChartTooltip(props){
  const chart=useContext(ChartDocument),ref=useRef(null),[size,setSize]=useState({width:220,height:100});
  useLayoutEffect(()=>{if(ref.current){const r=ref.current.getBoundingClientRect();setSize(old=>old.width===r.width&&old.height===r.height?old:{width:r.width,height:r.height});}},[props.active,props.label,props.payload]);
  if(!props.active||!props.payload?.length||!chart?.current)return null;
  const el=chart.current,doc=el.ownerDocument,win=doc.defaultView,r=el.getBoundingClientRect();
  const left=Math.max(8,Math.min(win.innerWidth-size.width-8,r.left+(props.coordinate?.x||0)+12));
  const top=Math.max(8,Math.min(win.innerHeight-size.height-8,r.top+(props.coordinate?.y||0)+12));
  return createPortal(<div ref={ref} role="tooltip" style={{position:'fixed',left,top,zIndex:25000,pointerEvents:'none',maxWidth:'min(340px,90vw)',fontSize:14}}><DefaultTooltipContent {...props} contentStyle={{...props.contentStyle,fontSize:14,color:'#e6eef5',background:'#07111a',border:'1px solid #294052',borderRadius:6}}/></div>,doc.fullscreenElement||doc.body);
}

// Recharts' window-scoped observer can retain dimensions from the main window
// after a chart moves into a popup. Measure in the chart's actual document.
export default function DocumentChartContainer({children}){
  const ref=useRef(null),[size,setSize]=useState({width:0,height:0});
  useLayoutEffect(()=>{
    const el=ref.current,win=el.ownerDocument.defaultView;
    const measure=()=>{const r=el.getBoundingClientRect();if(r.width>0&&r.height>0)setSize(old=>Math.abs(old.width-r.width)<.5&&Math.abs(old.height-r.height)<.5?old:{width:r.width,height:r.height});};
    const observer=new win.ResizeObserver(measure);observer.observe(el);win.addEventListener('resize',measure);measure();
    return()=>{observer.disconnect();win.removeEventListener('resize',measure);};
  },[]);
  return <div ref={ref} className="document-chart-container" style={{width:'100%',height:'100%',minWidth:0,minHeight:0}}><ChartDocument.Provider value={ref}>{size.width>0&&size.height>0&&cloneElement(children,size)}</ChartDocument.Provider></div>;
}
