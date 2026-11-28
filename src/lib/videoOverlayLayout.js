const EPS = 0.00001;
// Floating overlays stay floating. A narrower viewport only constrains bounds;
// collisions must never turn video review into a full-screen tiled dashboard.
export function projectOverlayLayout(boxes,width,height){
  return Object.fromEntries(Object.entries(boxes).map(([id,box])=>[id,fitOverlayBounds(id,box,width,height)]));
}
export const OVERLAY_GRID_PX=24;
export function snapOverlayBox(id,box,width,height,{enabled=true,mode='move'}={}) {
  const fitted=fitOverlayBounds(id,box,width,height);
  if(!enabled||!(width>0&&height>0))return fitted;
  const snap=(value,size)=>Math.round(value*size/OVERLAY_GRID_PX)*OVERLAY_GRID_PX/size;
  let next={...fitted};
  if(mode.includes('resize')){
    const min=fitOverlayBounds(id,{...box,w:0,h:0},width,height);
    next.w=Math.max(min.w,snap(next.w,width));
    next.h=Math.max(min.h,snap(next.h,height));
  }
  if(mode.includes('move')){next.x=snap(next.x,width);next.y=snap(next.y,height);}
  return fitOverlayBounds(id,{...next,w:Math.min(1,next.w),h:Math.min(1,next.h)},width,height);
}
export function meaningfulOverlayOverlap(a,b,{width=1200,height=800,tolerancePx=24}={}) {
  const x=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),y=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
  return x*width>tolerancePx&&y*height>tolerancePx&&(x*y>Math.min(a.w*a.h,b.w*b.h)*.04||Math.min(x*width,y*height)>48);
}
export function fitOverlayBounds(id,box,width,height) {
  if(!(width>0&&height>0))return box;
  const metric=id.startsWith('metric-'),pressure=id==='civet';
  const w=Math.min(1,Math.max(box.w,(metric?140:pressure?240:220)/width));
  const h=Math.min(1,Math.max(box.h,(metric?100:pressure?170:150)/height));
  return {...box,w,h,x:Math.max(0,Math.min(1-w,box.x)),y:Math.max(0,Math.min(1-h,box.y))};
}
export const overlaps = (a, b) => a.x < b.x+b.w-EPS && a.x+a.w > b.x+EPS && a.y < b.y+b.h-EPS && a.y+a.h > b.y+EPS;
export const fits = (box, boxes, id) => Object.entries(boxes).every(([key, other]) => key === id || !overlaps(box, other));
export function place(box, boxes, options={}) {
  const candidates=(values,size,max)=>options.gridPx&&size>0?[...new Set(values.flatMap(value=>[Math.floor(value*size/options.gridPx)*options.gridPx/size,Math.ceil(value*size/options.gridPx)*options.gridPx/size]).concat([0,max]))]:values;
  const xs = candidates([box.x, 0, ...Object.values(boxes).flatMap(b => [b.x+b.w+.006,b.x-box.w-.006]), 1-box.w],options.width,1-box.w);
  const ys = candidates([box.y, 0, ...Object.values(boxes).flatMap(b => [b.y+b.h+.006,b.y-box.h-.006]), 1-box.h],options.height,1-box.h);
  return ys.flatMap(y=>xs.map(x=>({...box,x,y}))).filter(next=>next.x>=0&&next.y>=0&&next.x+next.w<=1+EPS&&next.y+next.h<=1+EPS&&fits(next,boxes))
    .sort((a,b)=>Math.hypot(a.x-box.x,a.y-box.y)-Math.hypot(b.x-box.x,b.y-box.y))[0] || null;
}
// The picked-up card owns its destination. Move neighbors instead of rejecting
// the user's drop or shrinking their text. Dense layouts may stack; every card
// remains selectable and can be opened in its own full-size breakout.
export function reflowOverlay(boxes,id,patch,options) {
  if(!boxes[id])return boxes;
  const active={...boxes[id],...patch},next={[id]:active},displaced=[];
  for(const [key,box] of Object.entries(boxes))if(key!==id){if(options?meaningfulOverlayOverlap(active,box,options):overlaps(active,box))displaced.push([key,box]);else next[key]=box;}
  for(const [key,box] of displaced)next[key]=place(box,next,options)||box;
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
