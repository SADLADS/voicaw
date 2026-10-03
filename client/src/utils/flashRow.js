// Plays a one-off highlight animation (a CSS class, see dms.css) on a message row, restarting it
// if it's already running, and takes the class off once it's done.
const timers = new WeakMap(); // row -> its flash's timer, so a restarted flash isn't cut short
export function flashRow(row, className, ms = 2000) {
  clearTimeout(timers.get(row));
  row.classList.remove(className);
  void row.offsetWidth; // restarts the animation when it's flashed again
  row.classList.add(className);
  timers.set(row, setTimeout(() => row.classList.remove(className), ms));
}

// Touch screens don't hover, and they leave :hover on whatever was tapped last, so message rows
// there get a brief highlight on a tap instead (dms.css).
export function cannotHover() {
  return window.matchMedia?.('(hover: none)').matches ?? false;
}
