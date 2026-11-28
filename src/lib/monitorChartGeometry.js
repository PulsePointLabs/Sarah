// Port of Sarah Monitor ui/Charts.kt TrendChart/niceTicks (seconds in review,
// milliseconds in Kotlin). Rendering only; acquisition and evidence are untouched.
export function monitorNiceTicks(low,high,count){
  const span=high-low;if(!(span>0))return [low];
  const magnitude=10**Math.floor(Math.log10(span/Math.max(1,count)));
  const step=[1,2,2.5,5,10].map(n=>n*magnitude).find(n=>span/n<=Math.max(1,count))||10*magnitude;
  const first=Math.ceil(low/step)*step,out=[];
  for(let n=first;n<=high+1e-9&&out.length<20;n+=step)out.push(Math.abs(n)<1e-9?0:n);
  return out;
}
export function monitorBounds(values,minSpan=10,fixedBounds){
  if(fixedBounds?.length===2&&fixedBounds.every(Number.isFinite)&&fixedBounds[1]>fixedBounds[0])return fixedBounds;
  const known=values.filter(Number.isFinite);if(!known.length)return [0,minSpan];
  let low=Infinity,high=-Infinity;for(const value of known){low=Math.min(low,value);high=Math.max(high,value);}
  if(high-low<minSpan){const middle=(high+low)/2;low=middle-minSpan/2;high=middle+minSpan/2;}
  const pad=(high-low)*.1;return [low-pad,high+pad];
}
export function monitorPath(rows,key,{start,end,x,y,gapSeconds=30,breakBefore}={}){
  let previous=null;
  return rows.filter(row=>row.t>=start&&row.t<=end).map(row=>{
    const value=row[key];if(!Number.isFinite(value)){previous=null;return '';}
    const move=!previous||row.t-previous.t>gapSeconds||row.t<previous.t||row.gap||breakBefore?.(previous,row);
    previous=row;return `${move?'M':'L'}${x(row.t).toFixed(2)},${y(value).toFixed(2)}`;
  }).join(' ');
}
