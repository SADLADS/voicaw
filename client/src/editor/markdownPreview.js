// Markdown as you type (like Discord's message box): the text stays exactly as typed, markers
// included, but is shown the way the message will look: **bold**, __underline__, *italic* (also
// _italic_), ~~strikethrough~~, ||spoilers||, `code`, ``` code blocks ``` and > quotes (like
// Discord, # headings aren't previewed, though messages show them). The markers themselves are
// dimmed. This only draws (editor decorations); it never changes the text. Messages are drawn
// with utils/remarkDiscord.
//
// It's a small approximation of CommonMark (what messages are rendered with), line by line:
// emphasis only opens before a non-space and closes after one (spoilers needn't), `_` doesn't
// work inside words,
// a backslash escapes the next character, and nothing inside `code` is formatted.

// Each line becomes { block, spans }: `block` a class for the whole line (or null), `spans`
// [{ from, to, className }] with offsets into the line. `lines` are the paragraphs' text, with
// any chip or custom emoji as one character (see messageDoc's OBJECT_CHAR).
export function markdownPreview(lines) {
  let inFence = false;
  return lines.map((line) => {
    const fence = /^\s{0,3}```/.test(line);
    if (fence || inFence) {
      const opening = fence && !inFence;
      if (fence) inFence = !inFence;
      return {
        block: `md-code-block${opening ? ' md-code-block-start' : ''}${fence && !opening ? ' md-code-block-end' : ''}`,
        spans: fence ? [{ from: 0, to: line.length, className: 'md-syntax' }] : [],
      };
    }
    const quote = /^> /.exec(line);
    if (quote) {
      return {
        block: 'md-quote',
        spans: [{ from: 0, to: 2, className: 'md-syntax' }, ...inlineSpans(line, 2, line.length)],
      };
    }
    return { block: null, spans: inlineSpans(line, 0, line.length) };
  });
}

const isSpace = (ch) => ch === undefined || /\s/.test(ch);
const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

// Emphasis-like markers, longest first so ** is tried before *.
const MARKERS = [
  { text: '**', className: 'md-bold' },
  { text: '__', className: 'md-underline', wordBound: true },
  { text: '~~', className: 'md-strike' },
  { text: '||', className: 'md-spoiler', loose: true },
  { text: '*', className: 'md-italic' },
  { text: '_', className: 'md-italic', wordBound: true },
];

// Where the closing `marker` for one opened at `start` is (in [start + len, to)), or -1.
function findClose(line, marker, start, to) {
  const len = marker.text.length;
  for (let j = start + len + 1; j + len <= to; j++) {
    if (line[j] === '\\') {
      j++;
      continue;
    }
    if (line[j] === '`') {
      const end = codeEnd(line, j, to);
      if (end > 0) {
        j = end - 1;
        continue;
      }
    }
    const c = marker.text[0];
    if (line[j] === c) {
      // A run of the marker's character: where in it this marker would close (a run can close
      // an inner one too: the end of ***both*** closes * and **).
      let r = j;
      while (r < to && line[r] === c) r++;
      const run = r - j;
      let at = -1;
      if (len === 2 && run >= 2) at = r - 2;
      else if (len === 1 && run !== 2) at = r - 1;
      if (at >= start + len + 1 && (marker.loose || !isSpace(line[at - 1])) && !(marker.wordBound && isWordChar(line[at + len]))) {
        return at;
      }
      j = r - 1;
    }
  }
  return -1;
}

// If an inline code span starts at `i` (a run of backticks), the index just past its closing
// run; else -1.
function codeEnd(line, i, to) {
  let n = 0;
  while (line[i + n] === '`') n++;
  const ticks = '`'.repeat(n);
  for (let j = i + n; j + n <= to; j++) {
    if (line.startsWith(ticks, j) && line[j + n] !== '`' && line[j - 1] !== '`') return j + n;
  }
  return -1;
}

function inlineSpans(line, from, to) {
  const spans = [];
  let i = from;
  while (i < to) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < to && /[!-/:-@[-`{-~]/.test(line[i + 1])) {
      spans.push({ from: i, to: i + 1, className: 'md-syntax' });
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = codeEnd(line, i, to);
      if (end > 0) {
        let n = 0;
        while (line[i + n] === '`') n++;
        spans.push(
          { from: i, to: i + n, className: 'md-syntax' },
          { from: i + n, to: end - n, className: 'md-code' },
          { from: end - n, to: end, className: 'md-syntax' },
        );
        i = end;
        continue;
      }
      while (line[i] === '`') i++;
      continue;
    }
    const marker = MARKERS.find((m) => line.startsWith(m.text, i));
    if (marker) {
      const len = marker.text.length;
      const opens = (marker.loose || !isSpace(line[i + len])) && !(marker.wordBound && isWordChar(line[i - 1]));
      const close = opens ? findClose(line, marker, i, to) : -1;
      if (close > 0) {
        spans.push(
          { from: i, to: i + len, className: 'md-syntax' },
          { from: i + len, to: close, className: marker.className },
          ...inlineSpans(line, i + len, close),
          { from: close, to: close + len, className: 'md-syntax' },
        );
        i = close + len;
        continue;
      }
      i += len;
      continue;
    }
    i++;
  }
  return spans;
}
