// Which words in a piece of text are spellchecked, with where they are. Like a browser's
// checker, it leaves alone what isn't a plain word: links and email addresses, @mentions,
// #channels and :emoji:, anything with digits or underscores (abc123, snake_case), acronyms
// (NASA) and mixed case (iPhone, JavaScript), and single letters.

// Letters (with accents), joined by apostrophes: don't, o’clock.
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const LINKISH = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/giu;
const GLUED = /[\p{N}_]/u;

function isCheckable(word) {
  if ([...word].length < 2) return false;
  const rest = word.slice(1);
  if (rest !== rest.toLowerCase()) return false; // NASA, iPhone, McDonald
  return true;
}

// [{ word, from, to }] for `text` (`to` exclusive).
export function wordsIn(text) {
  const skipped = [];
  for (const match of text.matchAll(LINKISH)) skipped.push([match.index, match.index + match[0].length]);
  const words = [];
  for (const match of text.matchAll(WORD)) {
    const from = match.index;
    const to = from + match[0].length;
    if (skipped.some(([a, b]) => from < b && to > a)) continue;
    const before = text[from - 1] ?? '';
    const after = text[to] ?? '';
    if (GLUED.test(before) || GLUED.test(after)) continue;
    if (before === '@' || before === '#') continue;
    if (before === ':' && after === ':') continue;
    if (!isCheckable(match[0])) continue;
    words.push({ word: match[0], from, to });
  }
  return words;
}

// The word at `offset` in `text` (inside it or just after it), or null: what a right-click in
// a plain text box is on.
export function wordAt(text, offset) {
  return wordsIn(text).find((w) => offset >= w.from && offset <= w.to) ?? null;
}
