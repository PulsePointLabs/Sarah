// First-fit packing keeps every item in one finite grid. Resizing changes the
// available row height instead of creating rows beyond the viewport.
export function packTelemetry(items) {
  const occupied = [];
  const placements = items.map((item) => {
    const cols = Math.max(3, Math.min(12, Math.round(item.cols || 4)));
    const rows = Math.max(1, Math.min(8, Math.round(item.rows || 2)));
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
