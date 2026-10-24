// Describe the electrical input, not muscle identity or contraction quality.
export function emgInputDiagnostics(history = [], channel = 0, latest = null) {
  const values = history.map(row => row.raw?.[channel]).filter(Number.isFinite);
  const samples = values.length ? values : Number.isFinite(latest) ? [latest] : [];
  if (!samples.length) return {state:'missing',message:'No raw ADC samples available.'};
  const sorted = [...samples].sort((a,b)=>a-b);
  const min = sorted[0], max = sorted.at(-1), span = max-min;
  const low = sorted[Math.floor((sorted.length-1)*.05)], high = sorted[Math.floor((sorted.length-1)*.95)];
  let state='receiving',message='Serial data is arriving; muscle response has not been verified.';
  if (low >= 972) {state='high';message='Input near upper ADC limit. If relaxed, check gain, shield contacts and the signal/cable path.';}
  else if (high <= 3) {state='low';message='Input near zero. This can be rest or a signal-path problem; compare with a deliberate contraction.';}
  else if (samples.length >= 20 && high-low <= 3) {state='quiet';message='Very little input change. This alone cannot distinguish rest from a signal-path problem.';}
  return {state,message,min,max,span,count:samples.length};
}

export function emgPlotRange(history = [], channel = 0, detail = false) {
  if (!detail) return {min:0,max:1023};
  const values=history.flatMap(row=>[row.raw?.[channel],row.values?.[channel]]).filter(Number.isFinite);
  if (!values.length) return {min:0,max:1023};
  const low=Math.min(...values),high=Math.max(...values),padding=Math.max(4,(high-low)*.1);
  const width=Math.min(1023,Math.max(40,high-low+padding*2));
  const min=Math.max(0,Math.min(1023-width,(low+high-width)/2));
  return {min,max:min+width};
}
