// Weighted rows fill the viewport without reserved cells, holes or overlap.
// A minimum share prevents an oversized neighbor crushing a card into a strip.
export function tileTelemetry(items,width,height) {
  if(!items.length)return [];
  const w=Math.max(1,width),h=Math.max(1,height),weight=(item,axis)=>Math.max(.3,Math.min(6,Number(item[axis]??(axis==='widthWeight'?1:item.weight))||1));
  const metric=item=>item.kind==='metric'||String(item.id).startsWith('metric:');
  const compact=item=>metric(item)||item.id==='phase';
  const basis=item=>metric(item)?Math.min(180,w/2):['cardiac','threshold','respiratory','emg'].includes(item.id)?Math.min(520,w):item.id==='phase'?Math.min(320,w):Math.min(360,w);
  const rows=[];let row=[],used=0;
  for(const item of items){
    if(row.length&&(compact(row[0])!==compact(item)||used+basis(item)*weight(item,'widthWeight')>w+1)){rows.push(row);row=[];used=0;}
    row.push(item);used+=basis(item)*weight(item,'widthWeight');
  }
  if(row.length)rows.push(row);
  for(let i=1;i<rows.length;i++){if(rows[i].length===1&&compact(rows[i][0])&&compact(rows[i-1][0])&&rows[i-1].length>2)rows[i].unshift(rows[i-1].pop());}
  const rowWeights=rows.map(row=>row.reduce((n,item)=>n+weight(item,'heightWeight')*(compact(item)?.22:1),0));
  const total=rowWeights.reduce((a,b)=>a+b,0),out=[];
  const minimums=rows.map(r=>compact(r[0])?r.some(item=>item.id==='phase')?110:80:120),minimumTotal=minimums.reduce((a,b)=>a+b,0);
  const heights=rowWeights.map((value,i)=>minimumTotal>=h?h*minimums[i]/minimumTotal:minimums[i]+(h-minimumTotal)*value/total),panels=rows.map((r,i)=>compact(r[0])?-1:i).filter(i=>i>=0);
  if(panels.length){let extra=0;rows.forEach((r,i)=>{if(compact(r[0])&&!r.some(item=>item.heightWeight!=null)&&heights[i]>150){extra+=heights[i]-150;heights[i]=150;}});for(const i of panels)heights[i]+=extra*rowWeights[i]/panels.reduce((n,j)=>n+rowWeights[j],0);}
  let y=0;
  for(let i=0;i<rows.length;i++){
    const row=rows[i],sum=row.reduce((n,item)=>n+basis(item)*weight(item,'widthWeight'),0),rowH=heights[i];let x=0;
    const minWidths=row.map(item=>Math.min(w,metric(item)?110:item.id==='phase'?220:240)),minTotal=minWidths.reduce((a,b)=>a+b,0);
    for(const item of row){const itemIndex=row.indexOf(item),cardW=minTotal>=w?w*minWidths[itemIndex]/minTotal:minWidths[itemIndex]+(w-minTotal)*basis(item)*weight(item,'widthWeight')/sum;out.push({...item,x,y,width:cardW,height:rowH,viewportWidth:w});x+=cardW;}
    y+=rowH;
  }
  return out;
}
export function reorderTile(items,id,target){
  const next=[...items],from=next.findIndex(item=>item.id===id),to=next.findIndex(item=>item.id===target);
  if(from<0||to<0||from===to)return next;next.splice(to,0,next.splice(from,1)[0]);return next;
}
