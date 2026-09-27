import { useState } from 'react';
import CivetCard from './CivetCard.jsx';
import { civetRequest } from '../hooks/useCivet.js';
export default function CivetSetup({live,onClose}) {
  const [devices,setDevices]=useState([]),[address,setAddress]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[deflated,setDeflated]=useState(false);
  const action=async(name,body={})=>{setBusy(true);setError('');try{const data=await civetRequest(name,body);if(data.devices){setDevices(data.devices);setAddress(data.devices[0]?.address||'');if(!data.devices.length)setError('No CIVET found. Turn it on; press its power button five times until the Bluetooth icon is yellow, then scan again.');}}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-3"><section role="dialog" aria-modal="true" aria-label="Connect CIVET" className="w-full max-w-2xl max-h-[95vh] overflow-auto rounded-xl bg-card border p-4 space-y-3">
    <header className="flex justify-between"><h2 className="text-xl font-bold">CIVET pressure sensor</h2><button onClick={onClose}>Close</button></header>
    <p className="text-sm">Windows Bluetooth · records with the Sarah session · no device control</p>
    <div className="flex flex-wrap gap-2"><button disabled={busy} onClick={()=>action('install')} className="border rounded p-2">Install helper (once)</button><button disabled={busy} onClick={()=>action('scan')} className="border rounded p-2">Scan for CIVET</button>
      <select aria-label="CIVET device" value={address} onChange={e=>setAddress(e.target.value)} className="bg-background border rounded p-2"><option value="">Choose sensor</option>{devices.map(d=><option key={d.address} value={d.address}>{d.name} · {d.address}</option>)}</select>
      <button disabled={busy||!address} onClick={()=>action('connect',{address})} className="border rounded p-2">Connect</button><button disabled={busy} onClick={()=>action('disconnect')} className="border rounded p-2">Disconnect</button></div>
    <p role="status">{busy?'Working…':live.state}{live.battery!=null?` · Battery ${live.battery}%`:''}{live.recordingId?' · Recording to session':''}</p>
    {(error||live.error)&&<p role="alert" className="text-red-400 break-words">{error||live.error}</p>}
    <div style={{height:240}}><CivetCard sample={live.latest} rows={live.history}/></div>
    <div className="border rounded p-2 space-y-2"><label className="flex gap-2"><input type="checkbox" checked={deflated} onChange={e=>setDeflated(e.target.checked)}/>Sensor is fully deflated and outside the body</label><button disabled={busy||!live.latest||!deflated} className="border rounded p-2" onClick={()=>{action('zero',{deflated:true});setDeflated(false);}}>Zero CIVET while deflated</button><p className="text-sm">Optional hardware zero before insertion. Invalidates calibration; repeat baseline and reference afterward. A completed Bluetooth write does not independently verify the physical zero.</p></div>
    <p className="text-sm">In your recording position: relax for the five-second baseline, then hold a comfortable reference contraction for five seconds. Recalibrate after repositioning. Colors show pressure relative to that reference, not absolute muscle force.</p>
    <div className="flex gap-2"><button disabled={busy||!live.latest||live.latest.calibration_remaining_s>0} className="border rounded p-2" onClick={()=>action('calibrate',{kind:'baseline'})}>1 · Relaxed baseline (5s)</button><button disabled={busy||!live.latest?.calibration||live.latest?.quality_flags?.includes('calibration_invalidated')||live.latest.calibration_remaining_s>0} className="border rounded p-2" onClick={()=>action('calibrate',{kind:'reference'})}>2 · Contraction reference (5s)</button></div>
  </section></div>;
}
