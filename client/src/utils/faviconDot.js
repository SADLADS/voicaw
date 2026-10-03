// The browser tab's icon with a red dot while something counts as unread the way Discord's tab
// does: unread DMs and group messages, and guild mentions (`unreadSummary`'s `dot`; plain
// guild messages don't). Drawn once on a canvas from the logo, then swapped in and out
// as the `<link rel="icon">`'s href.

const SOURCE = '/logo192.png';
const SIZE = 64;
const DOT_COLOR = '#ed4245'; // the tray's dot (electron/tray.js)

let originalHref = null;
let dottedHref = null; // a data URL once drawn
let drawing = null;
let wanted = false;

function iconLink() {
  return document.querySelector('link[rel="icon"]');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function drawDotted() {
  const image = await loadImage(SOURCE);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.drawImage(image, 0, 0, SIZE, SIZE);
  // A dot in the bottom right corner, with a transparent ring so it stands off the logo.
  const r = SIZE * 0.24;
  const c = SIZE - r - 1;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(c, c, r + SIZE * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = DOT_COLOR;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toDataURL('image/png');
}

function apply() {
  const link = iconLink();
  if (!link) return;
  originalHref ??= link.getAttribute('href');
  const href = wanted && dottedHref ? dottedHref : originalHref;
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

export function setFaviconDot(dot) {
  wanted = Boolean(dot);
  if (wanted && !dottedHref) {
    drawing ??= drawDotted()
      .then((href) => { dottedHref = href; })
      .catch((err) => console.warn('Could not draw the unread favicon', err))
      .finally(() => { drawing = null; apply(); });
    return drawing;
  }
  apply();
  return Promise.resolve();
}

// For tests.
export function resetFaviconDot() {
  originalHref = null;
  dottedHref = null;
  drawing = null;
  wanted = false;
}
