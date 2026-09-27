import { CIVET_VERSION, CIVET_PARAMETERS, average, quantile, prominenceThreshold, createMorphologyDetector } from './civetAnalysis.js';
export const CIVET_ALGORITHM = CIVET_VERSION;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function createCivetProcessor() {
  let calibration=null,pending=null,window=[],events=[],last=null,tonic=null,invalid=false,count=0,sessionMax=0,heldAt=null,step=null,serial=0;
  const detector=createMorphologyDetector();
  function reset() {window=[];events=[];last=null;tonic=null;heldAt=null;step=null;pending=null;count=0;sessionMax=0;detector.reset();}
  return {
    reset,
    invalidate() {invalid=true;pending=null;detector.reset();},
    calibrate(kind) {
      if(!['baseline','reference'].includes(kind))throw new Error('Unknown calibration');
      if(kind==='reference'&&(!calibration||invalid))throw new Error('Capture relaxed baseline first.');
      pending={kind,samples:[],start:null};detector.reset();heldAt=null;
    },
    ingest(pressure,t,context={}) {
      if(!Number.isFinite(pressure)||!Number.isFinite(t))throw new Error('Invalid pressure sample');
      const dt=last?t-last.t:null;
      const gap=!!last&&(dt>.18||dt<=0||!!context.reconnected);
      const quality=[];let calibrationError=null,calibrationEvent=null;
      if(gap){quality.push('packet_gap');window=[];heldAt=null;step=null;tonic=null;invalid=true;}
      if(pending) {
        pending.start??=t;pending.samples.push(pressure);pending.invalid ||=gap;
        if(t-pending.start>=5-1e-6) {
          const a=pending.samples,baseline=average(a),variance=average(a.map(v=>(v-baseline)**2)),noise=Math.sqrt(variance);
          const drift=Math.abs(average(a.slice(-10))-average(a.slice(0,10)));
          if(a.length<45||pending.invalid)calibrationError='Missing samples during calibration; repeat baseline.';
          else if(pending.kind==='baseline') {
            if(noise>.12 || drift>.15)calibrationError='Baseline is unstable; relax and check placement, then repeat.';
            else {calibration={id:`cal-${context.timestamp_ms??t}-${++serial}`,baseline,noise,variance,reference:null,at:t,timestamp_ms:context.timestamp_ms??null,quality:'baseline only',baseline_drift_kpa:drift};invalid=false;}
          } else {
            const reference=quantile(a,.95)-calibration.baseline;
            if(reference<Math.max(.1,calibration.noise*6))calibrationError='Reference is too small or noisy. Repeat baseline and contraction reference.';
            else if(quantile(a,.25)-calibration.baseline<reference*.3)calibrationError='Reference was not held steadily; repeat the five-second contraction.';
            else calibration={...calibration,id:`cal-${context.timestamp_ms??t}-${++serial}`,reference,at:t,timestamp_ms:context.timestamp_ms??null,quality:'valid',reference_variance:variance};
          }
          calibrationEvent={type:'calibration',kind:pending.kind,t,timestamp_ms:context.timestamp_ms??null,success:!calibrationError,error:calibrationError,calibration};
          if(calibrationError)invalid=true;
          pending=null;detector.reset();window=[];heldAt=null;step=null;tonic=calibration?.baseline??pressure;
        }
      }
      tonic=tonic==null?pressure:tonic+(1-Math.exp(-Math.max(0,dt||.1)/CIVET_PARAMETERS.tonic_tau_s))*(pressure-tonic);
      const delta=calibration?pressure-calibration.baseline:null,h=prominenceThreshold(calibration);
      // Pressure alone cannot identify the source of a step. Flag suspicion, never
      // label a particular movement or compression as a proven cause.
      if(last&&!gap&&!pending&&Math.abs(pressure-last.pressure_kpa)>Math.max(.4,(calibration?.reference||1)*.6)) {
        quality.push('abrupt_pressure_change');step={t,from:last.pressure_kpa,to:pressure};
      }
      if(step&&t-step.t>=2) {
        if(Math.abs(pressure-step.to)<Math.abs(step.to-step.from)*.2 && (!calibration || Math.abs(step.to-calibration.baseline)>Math.max(.2,calibration.noise*6))) {quality.push('possible_reposition_or_external_pressure');invalid=true;}
        step=null;
      }
      window.push({t,pressure_kpa:pressure,delta});window=window.filter(r=>t-r.t<=30);
      const recentFloor=window.filter(r=>t-r.t<=8);
      if(calibration&&!pending&&recentFloor.length>=75) {
        const floor=quantile(recentFloor.map(r=>r.pressure_kpa),.1);
        if(floor-calibration.baseline>Math.max(.4,(calibration.reference||1)*.6)||floor-calibration.baseline< -Math.max(.2,calibration.noise*6)) {invalid=true;quality.push('baseline_drift_or_tonic_shift');}
      }
      if(invalid)quality.push('calibration_invalidated');
      if(pending)quality.push('calibrating');
      const usable=!!calibration?.reference&&!invalid&&!pending&&!gap;
      if(usable&&delta>=h)heldAt??=t;else heldAt=null;
      const held=heldAt==null?0:t-heldAt;
      const row={t,pressure_kpa:pressure,delta_kpa:delta,filtered_kpa:pressure,tonic_kpa:tonic,phasic_kpa:pressure-tonic,
        calibration,calibration_valid:usable,quality_flags:quality,gap,gap_s:gap?dt:null,mode:'live',algorithm:CIVET_VERSION};
      const emitted=pending?[]:detector.ingest(row);events.push(...emitted);count+=emitted.length;events=events.filter(e=>t-e.confirmed_at<=60);
      const recent=events.filter(e=>t-e.peak<=10&&e.quality==='usable'&&e.calibration?.id===calibration?.id);
      const intervals=recent.slice(1).map((e,i)=>e.peak-recent[i].peak),interval=average(intervals);
      const cv=interval?Math.sqrt(average(intervals.map(v=>(v-interval)**2)))/interval:null;
      const rhythm=usable&&recent.length>=3&&interval<=3&&cv<.35;
      const values=window.map(r=>r.delta).filter(Number.isFinite);
      if(usable)sessionMax=Math.max(sessionMax,delta);
      const evidence=usable?(rhythm?'rhythmic contractions':held>=3?'sustained contraction':heldAt!=null?'contraction':'relaxed'):pending?`calibrating ${pending.kind}`:calibrationError?'calibration failed':invalid?'placement / signal changed · recalibrate':'calibration needed';
      last=row;
      return {...row,level_pct:usable?clamp(delta/calibration.reference*100,0,150):null,avg_kpa:values.length?average(values):null,max_kpa:values.length?Math.max(...values):null,
        session_max_kpa:sessionMax,contractions_60s:events.filter(e=>e.quality==='usable').length,contraction_count:count,duration_s:held,mean_duration_s:average(events.map(e=>e.duration_s)),
        rhythm,evidence,usable,events:emitted,calibration_event:calibrationEvent,calibration_error:calibrationError,calibration_remaining_s:pending?Math.max(0,5-(t-pending.start)):0};
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
