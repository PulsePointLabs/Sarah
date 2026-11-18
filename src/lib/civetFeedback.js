export function civetFeedback(live){
  const sample=live?.latest;
  if(!sample)return live?.state==='not_in_use'?'CIVET not connected':'No fresh pressure signal';
  if(!sample.calibration_valid)return sample.calibration_status?.phase==='collecting'?'Measuring your reference · keep pressure steady':sample.baseline_ready?'Rest saved · complete a comfortable hold':sample.acquisition_message||'Live pressure received · collect rest and a comfortable hold';
  if(sample.rhythm)return 'Repeated pressure pulses detected';
  if(sample.duration_s>=1&&['sustained contraction','contraction'].includes(sample.evidence))return `Pressure held above rest · ${Math.round(sample.duration_s)} seconds`;
  if(sample.level_pct>=100)return 'Above your reference hold · not a maximum-strength score';
  if(sample.delta_kpa>Math.max(.1,(sample.calibration?.noise||0)*6))return 'Pressure above your resting reference';
  return 'Near your resting pressure';
}
