import nspell from 'nspell';
import { rankSuggestions } from './rankSuggestions';

// The spellchecker itself (nspell: Hunspell in JavaScript), off the main thread: reading a
// dictionary takes a moment. Messages: { id, type: 'load', aff, dic } (URLs), { id, type:
// 'check', words } -> the misspelled ones, { id, type: 'suggest', word } -> up to 5 words.
// Replies { id, result } or { id, error }.
let speller = null;

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the dictionary (${res.status})`);
  return res.text();
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    let result;
    if (type === 'load') {
      const [aff, dic] = await Promise.all([text(data.aff), text(data.dic)]);
      speller = nspell(aff, dic);
      result = true;
    } else if (type === 'check') {
      result = data.words.filter((word) => !speller.correct(word));
    } else if (type === 'suggest') {
      result = rankSuggestions(data.word, speller.suggest(data.word)).slice(0, 5);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
