import { CIVET_VERSION, CIVET_PARAMETERS, average, quantile, prominenceThreshold, createMorphologyDetector } from './civetAnalysis.js';
import { createCivetReadiness, CIVET_ACQUISITION_POLICY } from './civetReadiness.js';
import { calibrationFeedback } from './civetCalibration.js';
export const CIVET_ALGORITHM = CIVET_VERSION;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function createCivetProcessor({ verifiedCalibration = null } = {}) {
  if (verifiedCalibration && (!Number.isFinite(verifiedCalibration.baseline) || !Number.isFinite(verifiedCalibration.reference) || verifiedCalibration.reference <= 0 || !Number.isFinite(verifiedCalibration.noise) || verifiedCalibration.noise < 0)) throw new Error('Invalid recorded calibration');
  // Offline replay may start at an already verified recorded sample. Live capture
  // always starts without a reference and uses the full rest/hold/release sequence.
  let calibration=verifiedCalibration ? {...verifiedCalibration} : null,pending=null,window=[],events=[],last=null,tonic=null,invalid=false,count=0,sessionMax=0,heldAt=null,step=null,serial=0,lastCalibrationError=null,baselineReady=!!verifiedCalibration,calibrationStatus=null,signalStart=-Infinity;
  const detector=createMorphologyDetector();
  const readiness=createCivetReadiness();
  function reset() {signalStart=-Infinity;if(pending){readiness.invalidate("Calibration interrupted. Repeat rest and hold.");baselineReady=false;}readiness.reset();window=[];events=[];last=null;tonic=null;heldAt=null;step=null;pending=null;calibrationStatus=null;count=0;sessionMax=0;detector.reset();}
  return {
    reset,
    invalidate() {readiness.invalidate();invalid=true;baselineReady=false;calibrationStatus=null;if(pending)lastCalibrationError='Calibration interrupted; repeat baseline and reference.';pending=null;detector.reset();},
    calibrate(kind,{prepareS=0}={}) {
      if(!['baseline','reference'].includes(kind))throw new Error('Unknown calibration');
      if(kind==='reference'&&!baselineReady)throw new Error('Capture relaxed baseline first.');
      if(kind==='baseline')baselineReady=false;
      if(!Number.isFinite(prepareS)||prepareS<0||prepareS>10)throw new Error('Invalid preparation duration.');
      lastCalibrationError=null;calibrationStatus=null;pending={kind,samples:[],start:null,prepareS};detector.reset();heldAt=null;step=null;
    },
    ingest(pressure,t,context={}) {
      if(!Number.isFinite(pressure)||!Number.isFinite(t))throw new Error('Invalid pressure sample');
      const dt=last?t-last.t:null;
      // Host receive timestamps can coincide when Windows delivers queued BLE notifications.
      // Keep actual timestamps; tolerate up to 350 ms delivery jitter without inventing samples.
      const gap=!!last&&(dt>CIVET_PARAMETERS.live_gap_s+1e-6||dt<0||!!context.reconnected);
      const quality=[];let calibrationError=lastCalibrationError,calibrationEvent=null;
      if(gap){signalStart=t;quality.push('packet_gap');window=[];heldAt=null;step=null;tonic=null;if(context.reconnected||dt>2||dt<0){invalid=true;baselineReady=false;}}
      if(pending) {
        pending.start??=t+pending.prepareS;if(t>=pending.start-1e-6)pending.samples.push(pressure);pending.invalid ||= !!context.reconnected || (t>=pending.start-1e-6 && gap && t-Math.max(last?.t??t,pending.start)>CIVET_PARAMETERS.live_gap_s);
        const feedback=calibrationFeedback(pending.samples,pending.kind,calibration);
        if(pending.invalid)Object.assign(feedback,{tone:'warning',acceptable:false,message:'Signal interrupted. Reconnect if needed, then redo rest.'});
        calibrationStatus={kind:pending.kind,phase:t<pending.start-1e-6?'preparing':'collecting',...feedback};
        if(t-pending.start>=5-1e-6) {
          const a=pending.samples,baseline=average(a),variance=average(a.map(v=>(v-baseline)**2)),noise=Math.sqrt(variance);
          const drift=Math.abs(average(a.slice(-10))-average(a.slice(0,10)));
          if(a.length<45||pending.invalid)calibrationError=`Pressure sampling interrupted (${a.length} samples in 5 seconds; at least 45 required). Redo ${pending.kind==='baseline'?'rest':'hold'}.`;
          else if(pending.kind==='baseline') {
            if(!feedback.acceptable)calibrationError=feedback.message;
            else {calibration={id:`cal-${context.timestamp_ms??t}-${++serial}`,policy:'pressure-stability-1',baseline,noise,variance,reference:null,at:t,timestamp_ms:context.timestamp_ms??null,quality:'baseline only',baseline_drift_kpa:drift};invalid=false;baselineReady=true;readiness.baseline();}
          } else {
            const reference=quantile(a,.95)-calibration.baseline;
            if(reference<Math.max(.1,calibration.noise*6))calibrationError='Reference is too small or noisy. Rest, then redo the hold.';
            else if(quantile(a,.25)-calibration.baseline<reference*.3)calibrationError='Reference was not held steadily; repeat the five-second contraction.';
            else if(!feedback.acceptable)calibrationError=feedback.message;
            else {calibration={...calibration,id:`cal-${context.timestamp_ms??t}-${++serial}`,reference,at:t,timestamp_ms:context.timestamp_ms??null,quality:'valid',reference_variance:variance};invalid=false;readiness.reference(t);}
          }
          calibrationEvent={type:'calibration',policy:'pressure-stability-1',kind:pending.kind,t,timestamp_ms:context.timestamp_ms??null,success:!calibrationError,error:calibrationError,calibration};
          calibrationStatus={kind:pending.kind,phase:calibrationError?'failed':pending.kind==='baseline'?'baseline_accepted':'settling',tone:calibrationError?'warning':pending.kind==='baseline'?'good':'waiting',message:calibrationError||(pending.kind==='baseline'?'Rest accepted. Ready for the five-second hold.':'Hold accepted. Release and relax to finish calibration.')};
          lastCalibrationError=calibrationError;if(calibrationError)invalid=true;
          pending=null;detector.reset();window=[];heldAt=null;step=null;tonic=calibration?.baseline??pressure;
        }
      }
      tonic=tonic==null?pressure:tonic+(1-Math.exp(-Math.max(0,dt||.1)/CIVET_PARAMETERS.tonic_tau_s))*(pressure-tonic);
      const delta=calibration?pressure-calibration.baseline:null,h=prominenceThreshold(calibration);
      if(last&&!gap&&!pending&&Math.abs(pressure-last.pressure_kpa)>Math.max(.4,(calibration?.reference||1)*.6)) quality.push('abrupt_pressure_change');
      window.push({t,pressure_kpa:pressure,delta});window=window.filter(r=>t-r.t<=30);
      const acquisition=readiness.step({t,calibration,rows:window,gap,dt,reconnected:context.reconnected,pending,failed:calibrationError});
      invalid=['recalibrate','checking','recovering'].includes(acquisition.state);
      if(acquisition.state==='recalibrate'&&!calibrationError)baselineReady=false;
      if(acquisition.state==='checking'||acquisition.state==='recalibrate')quality.push('baseline_drift_or_tonic_shift');
      if(invalid)quality.push('calibration_invalidated');
      if(pending)quality.push('calibrating');
      const usable=acquisition.valid;if(usable)baselineReady=true;
      if(!pending&&!calibrationError)calibrationStatus={kind:calibration?.reference?'reference':calibrationStatus?.kind,phase:acquisition.state,tone:usable?'good':'warning',message:acquisition.message};
      if(usable&&delta>=h)heldAt??=t;else heldAt=null;
      const held=heldAt==null?0:t-heldAt;
      const row={t,pressure_kpa:pressure,delta_kpa:delta,filtered_kpa:pressure,tonic_kpa:tonic,phasic_kpa:pressure-tonic,
        calibration,calibration_valid:usable,acquisition_policy:CIVET_ACQUISITION_POLICY,acquisition_state:acquisition.state,acquisition_message:acquisition.message,settling_remaining_s:acquisition.remaining,quality_flags:quality,gap,gap_s:gap?dt:null,mode:'live',algorithm:CIVET_VERSION};
      // Peak shape remains measurable without a trusted strength reference. Keep signal flags separate.
      const signalFlags=quality.filter(f=>['packet_gap','abrupt_pressure_change'].includes(f));
      const emitted=pending||acquisition.settling?[]:detector.ingest({...row,calibration_valid:true,quality_flags:signalFlags}).map(e=>({...e,calibration_valid:usable,reference_quality:acquisition.state,pressure_only:true}));events.push(...emitted);count+=emitted.length;events=events.filter(e=>t-e.confirmed_at<=60);
      const recent=events.filter(e=>t-e.peak<=10&&e.peak>=signalStart&&e.quality==='usable'&&e.calibration?.id===calibration?.id);
      const intervals=recent.slice(1).map((e,i)=>e.peak-recent[i].peak),interval=average(intervals);
      const cv=interval?Math.sqrt(average(intervals.map(v=>(v-interval)**2)))/interval:null;
      const rhythm=usable&&recent.length>=3&&interval<=3&&cv<.35;
      const values=window.map(r=>r.delta).filter(Number.isFinite);
      if(usable)sessionMax=Math.max(sessionMax,delta);
      const evidence=usable?(rhythm?'rhythmic contractions':held>=3?'sustained contraction':heldAt!=null?'contraction':'relaxed'):pending?`calibrating ${pending.kind}`:calibrationError?'calibration failed':invalid?'placement / signal changed · recalibrate':'calibration needed';
      last=row;
      return {...row,level_pct:usable?clamp(delta/calibration.reference*100,0,150):null,avg_kpa:values.length?average(values):null,max_kpa:values.length?Math.max(...values):null,
        session_max_kpa:sessionMax,contractions_60s:events.filter(e=>e.quality==='usable').length,uncertain_pulses_60s:events.filter(e=>e.quality!=='usable').length,contraction_count:count,duration_s:held,mean_duration_s:average(events.map(e=>e.duration_s)),
        rhythm,evidence,usable,peak_candidates:detector.takeCandidates(),acquisition_event:acquisition.event?{...acquisition.event,timestamp_ms:context.timestamp_ms??null}:null,events:emitted,calibration_event:calibrationEvent,calibration_error:calibrationError,calibration_status:calibrationStatus,baseline_ready:baselineReady,calibration_preparing_s:pending?Math.max(0,pending.start-t):0,calibration_remaining_s:pending?Math.min(5,Math.max(0,5-(t-pending.start))):0};
    },
  };
}
export function civetEvidence(sample) {
  if(!sample?.usable || sample?.mode==='review')return {contribution:0,label:null};
  return {contribution:sample.rhythm?8:sample.duration_s>=3?4:0,label:sample.rhythm?'CIVET rhythmic contraction pattern':sample.duration_s>=3?'CIVET sustained contraction':null};
}
export function civetAt(rows,t) {
  let lo=0,hi=rows.length-1,found=null;
  while(lo<=hi){const mid=(lo+hi)>>1;if(rows[mid].t<=t){found=rows[mid];lo=mid+1;}else hi=mid-1;}
  return found&&t-found.t<=.18?found:null;
}
export function withCivetEvidence(base,sample,emgLevel=0) {
  const evidence=civetEvidence(sample);
  const addition=base.buildEligibleForNearClimax&&base.recovery<45?Math.max(0,evidence.contribution-Math.min(8,Math.max(0,emgLevel)*.16)):0;
  return {...base,nearClimax:Math.min(100,base.nearClimax+addition),civetContribution:addition,civetEvidence:evidence.label,reason:[base.reason,evidence.label].filter(Boolean).join(' · ')};
}
