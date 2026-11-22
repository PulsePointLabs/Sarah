const EPS = 0.00001;
export function fitOverlayBounds(id,box,width,height) {
  if(!(width>0&&height>0))return box;
  const metric=id.startsWith('metric-'),pressure=id==='civet';
  const w=Math.min(1,Math.max(box.w,(metric?180:id==='phase'||pressure?360:320)/width));
  const h=Math.min(1,Math.max(box.h,(metric?120:pressure?340:id==='phase'?340:250)/height));
  return {...box,w,h,x:Math.max(0,Math.min(1-w,box.x)),y:Math.max(0,Math.min(1-h,box.y))};
}
export const overlaps = (a, b) => a.x < b.x+b.w-EPS && a.x+a.w > b.x+EPS && a.y < b.y+b.h-EPS && a.y+a.h > b.y+EPS;
export const fits = (box, boxes, id) => Object.entries(boxes).every(([key, other]) => key === id || !overlaps(box, other));
export function place(box, boxes) {
  const xs = [box.x, 0, ...Object.values(boxes).flatMap(b => [b.x+b.w+.006,b.x-box.w-.006]), 1-box.w];
  const ys = [box.y, 0, ...Object.values(boxes).flatMap(b => [b.y+b.h+.006,b.y-box.h-.006]), 1-box.h];
  return ys.flatMap(y=>xs.map(x=>({...box,x,y}))).filter(next=>next.x>=0&&next.y>=0&&next.x+next.w<=1+EPS&&next.y+next.h<=1+EPS&&fits(next,boxes))
    .sort((a,b)=>Math.hypot(a.x-box.x,a.y-box.y)-Math.hypot(b.x-box.x,b.y-box.y))[0] || null;
}
// The picked-up card owns its destination. Move neighbors instead of rejecting
// the user's drop or shrinking their text. Dense layouts may stack; every card
// remains selectable and can be opened in its own full-size breakout.
export function reflowOverlay(boxes,id,patch) {
  if(!boxes[id])return boxes;
  const active={...boxes[id],...patch},next={[id]:active},displaced=[];
  for(const [key,box] of Object.entries(boxes))if(key!==id){if(overlaps(active,box))displaced.push([key,box]);else next[key]=box;}
  for(const [key,box] of displaced)next[key]=place(box,next)||box;
  return Object.fromEntries(Object.keys(boxes).map(key=>[key,next[key]]));
}
export function restoreLayout(boxes) {
  const result = {};
  for (const [id,box] of Object.entries(boxes)) {
    const next = place(box,result);
    if (!next) {
      const entries=Object.entries(boxes), cols=Math.ceil(Math.sqrt(entries.length)), rows=Math.ceil(entries.length/cols);
      return Object.fromEntries(entries.map(([key,b],i)=>[key,{...b,x:(i%cols)/cols,y:Math.floor(i/cols)/rows,w:1/cols-.006,h:1/rows-.006}]));
    }
    result[id]=next;
  }
  return result;
}
