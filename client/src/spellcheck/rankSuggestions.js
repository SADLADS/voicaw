// nspell lists its suggestions in no useful order ("wrold": wold before world). These come
// closest first: fewest edits (two letters swapped counts as one), then the same letters
// rearranged, then the same length, then nspell's order.

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const letters = (word) => [...word.toLowerCase()].sort().join('');

export function rankSuggestions(word, suggestions) {
  const lower = word.toLowerCase();
  return suggestions
    .map((s, i) => ({
      s,
      i,
      distance: editDistance(lower, s.toLowerCase()),
      anagram: letters(s) === letters(word) ? 0 : 1,
      length: s.length === word.length ? 0 : 1,
    }))
    .sort((x, y) => x.distance - y.distance || x.anagram - y.anagram || x.length - y.length || x.i - y.i)
    .map((x) => x.s);
}
