// How wide camera tiles can be to fill a box without scrolling: tries every number of columns
// and keeps the biggest tile that fits. With too many cameras for `minWidth`, tiles of that width
// (the box then scrolls), never wider than the box.
export function fitTileWidth({ width, height, count, gap = 12, aspect = 16 / 9, minWidth = 160 }) {
  if (width <= 0 || height <= 0 || count <= 0) return minWidth;
  let best = 0;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const byWidth = (width - gap * (columns - 1)) / columns;
    const byHeight = ((height - gap * (rows - 1)) / rows) * aspect;
    best = Math.max(best, Math.min(byWidth, byHeight));
  }
  return Math.floor(Math.min(width, Math.max(best, minWidth)));
}
