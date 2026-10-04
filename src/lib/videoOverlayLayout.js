const EPS = 0.00001;
export const overlaps = (a, b) => a.x < b.x+b.w-EPS && a.x+a.w > b.x+EPS && a.y < b.y+b.h-EPS && a.y+a.h > b.y+EPS;
export const fits = (box, boxes, id) => Object.entries(boxes).every(([key, other]) => key === id || !overlaps(box, other));
export function place(box, boxes) {
  const xs = [box.x, 0, ...Object.values(boxes).map(b => b.x+b.w+.006), 1-box.w];
  const ys = [box.y, 0, ...Object.values(boxes).map(b => b.y+b.h+.006), 1-box.h];
  for (const y of ys) for (const x of xs) {
    const next = {...box,x,y};
    if (x+box.w<=1 && y+box.h<=1 && fits(next,boxes)) return next;
  }
  return null;
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
