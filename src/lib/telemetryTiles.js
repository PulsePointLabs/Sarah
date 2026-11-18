// Weighted rows fill the viewport without reserved cells, holes or overlap.
// A minimum share prevents an oversized neighbor crushing a card into a strip.
export function tileTelemetry(items,width,height) {
  if(!items.length)return [];
  const w=Math.max(1,width),h=Math.max(1,height),weight=item=>Math.max(.35,Math.min(5,Number(item.weight)||1));
  const rowCount=Math.max(1,Math.min(items.length,Math.round(Math.sqrt(items.length*h/w))));
  const rows=Array.from({length:rowCount},(_,i)=>items.slice(Math.floor(i*items.length/rowCount),Math.floor((i+1)*items.length/rowCount)));
  const total=items.reduce((n,item)=>n+weight(item),0),minH=Math.min(92,h/rowCount*.65),out=[];let y=0;
  for(const row of rows){
    const sum=row.reduce((n,item)=>n+weight(item),0),rowH=minH+(h-minH*rowCount)*sum/total,minW=Math.min(100,w/row.length*.7);let x=0;
    for(const item of row){const cardW=minW+(w-minW*row.length)*weight(item)/sum;out.push({...item,x,y,width:cardW,height:rowH});x+=cardW;}
    y+=rowH;
  }
  return out;
}
export function reorderTile(items,id,target){
  const next=[...items],from=next.findIndex(item=>item.id===id),to=next.findIndex(item=>item.id===target);
  if(from<0||to<0||from===to)return next;next.splice(to,0,next.splice(from,1)[0]);return next;
}
