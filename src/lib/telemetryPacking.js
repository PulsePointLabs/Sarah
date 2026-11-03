// First-fit packing keeps every item in one finite grid. Resizing changes the
// available row height instead of creating rows beyond the viewport.
export function packTelemetry(items) {
  const occupied = [];
  const fixed = new Map();
  const reserve = p => {for(let r=p.y;r<p.y+p.rows;r++){occupied[r] ||= Array(12).fill(false);for(let c=p.x;c<p.x+p.cols;c++)occupied[r][c]=true;}};
  // Saved positions reserve their space before automatic cards are packed.
  for(const item of items){
    const cols=Math.max(3,Math.min(12,Math.round(item.cols||4))),rows=Math.max(2,Math.min(8,Math.round(item.rows||2)));
    const p={id:item.id,cols,rows,x:Math.round(item.x),y:Math.round(item.y)};
    if(Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x+cols<=12&&p.y>=0&&p.y<=80
      && Array.from({length:rows},(_,r)=>Array.from({length:cols},(_,c)=>!occupied[p.y+r]?.[p.x+c]).every(Boolean)).every(Boolean)){
      fixed.set(item.id,p);reserve(p);
    }
  }
  const placements = items.map((item) => {
    if(fixed.has(item.id))return fixed.get(item.id);
    const cols = Math.max(3, Math.min(12, Math.round(item.cols || 4)));
    const rows = Math.max(2, Math.min(8, Math.round(item.rows || 2)));
    let y = 0, x = 0;
    search: for (;; y++) {
      for (x = 0; x <= 12 - cols; x++) {
        let free = true;
        for (let r = y; r < y + rows; r++) for (let c = x; c < x + cols; c++) if (occupied[r]?.[c]) free = false;
        if (free) break search;
      }
    }
    for (let r = y; r < y + rows; r++) {
      occupied[r] ||= Array(12).fill(false);
      for (let c = x; c < x + cols; c++) occupied[r][c] = true;
    }
    return { id: item.id, cols, rows, x, y };
  });
  return { placements, rows: Math.max(1, occupied.length) };
}

export function telemetryPositionFree(candidate, placements, totalRows) {
  if(candidate.x<0||candidate.y<0||candidate.x+candidate.cols>12||candidate.y+candidate.rows>totalRows)return false;
  return placements.every(other=>other.id===candidate.id || candidate.x>=other.x+other.cols || candidate.x+candidate.cols<=other.x || candidate.y>=other.y+other.rows || candidate.y+candidate.rows<=other.y);
}
