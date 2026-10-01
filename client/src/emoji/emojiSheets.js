// Sprite sheets of the default emoji for the picker, like Discord's: one image per category
// with every emoji on a grid, instead of ~1,850 separate SVGs fetched as they scroll into
// view (which left the picker filling in one emoji at a time on any device that hadn't seen
// them yet). Made at build time from the Twemoji SVGs by the twemojiAssets plugin in
// vite.config.js and served at /emoji/sheets/<key>/<name>.webp; the layout is worked out
// from the emoji data, so the page finds any emoji's cell without a map file. Shared by the
// page, the build (vite.config.js) and the service worker, so it imports nothing.

export const SHEET_COLUMNS = 16;
// Pixels per cell: twice the picker's 28px, so sharp on high-density screens.
export const SHEET_CELL = 56;
// Bump when the layout or rendering changes, so devices fetch the new sheets (the cell size
// is in the key already).
const LAYOUT_VERSION = 1;

// The versions are @twemoji/svg's (the art) and @emoji-mart/data's (what's on each sheet).
export function sheetKey(twemojiVersion, dataVersion) {
  return `${twemojiVersion}-${dataVersion}-${LAYOUT_VERSION}-${SHEET_CELL}`;
}

// The emoji-mart categories (a test checks they match the data), each one sheet in the
// default tone. The service worker fetches these before the picker is first opened.
export const CATEGORY_SHEETS = ['people', 'nature', 'foods', 'activity', 'places', 'objects', 'symbols', 'flags'];
// Emoji with skin tones get one more sheet per tone (`tone1`…`tone5`), holding only them.
export const SKIN_TONES = 5;

export function sheetPath(key, name) {
  return `sheets/${key}/${name}.webp`;
}

// [{ name, cells: [unified, …] }] for the emoji-mart data set, cells in reading order.
export function emojiSheets(data) {
  const sheets = data.categories.map((category) => ({
    name: category.id,
    cells: category.emojis.map((id) => data.emojis[id].skins[0].unified),
  }));
  const toned = data.categories.flatMap((category) => category.emojis)
    .map((id) => data.emojis[id])
    .filter((emoji) => emoji.skins.length > SKIN_TONES);
  for (let tone = 1; tone <= SKIN_TONES; tone += 1) {
    sheets.push({ name: `tone${tone}`, cells: toned.map((emoji) => emoji.skins[tone].unified) });
  }
  return sheets;
}

// unified -> { sheet, col, row, rows }: where each emoji is drawn.
export function spriteMap(data) {
  const map = new Map();
  for (const { name, cells } of emojiSheets(data)) {
    const rows = Math.ceil(cells.length / SHEET_COLUMNS);
    cells.forEach((unified, i) => {
      if (!map.has(unified)) map.set(unified, { sheet: name, col: i % SHEET_COLUMNS, row: Math.floor(i / SHEET_COLUMNS), rows });
    });
  }
  return map;
}

// An element shows one cell, at whatever size it is: the class `emoji-sheet-<sheet>` gives
// the sheet (CSS from `sheetCss`, written once) and `spritePosition` its inline
// background-position. Few inline styles, since the picker draws ~1,850 of them.
export function spritePosition({ col, row, rows }) {
  const at = (i, n) => (n > 1 ? `${(i / (n - 1)) * 100}%` : '0');
  return `${at(col, SHEET_COLUMNS)} ${at(row, rows)}`;
}

// `sheetUrl(name)` gives a sheet's URL.
export function sheetCss(data, sheetUrl) {
  return emojiSheets(data).map(({ name, cells }) => (
    `.emoji-sheet-${name}{background-image:url("${sheetUrl(name)}");`
    + `background-size:${SHEET_COLUMNS * 100}% ${Math.ceil(cells.length / SHEET_COLUMNS) * 100}%}`
  )).join('\n');
}
