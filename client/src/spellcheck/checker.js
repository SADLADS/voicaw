import { spellcheckLanguage, subscribeSpellcheck } from '../utils/spellcheck';
import { hasWord, subscribeDictionary } from './personalDictionary';

// Our spellchecker, as the page sees it: `misspelled(word)` answers at once from what's
// known (true / false), or undefined while the worker (spellWorker.js) is asked; listeners
// hear when answers come in, the language changes or the personal dictionary does, so the
// editors (spellcheckPlugin.js) draw their underlines again. Nothing runs, and no dictionary
// is fetched, until an editor asks.

// The engine for a language: { check(words) -> Promise<misspelled words>, suggest(word) ->
// Promise<words>, close() }. Tests swap it (setEngineFactory).
async function workerEngine(language) {
  const { DICTIONARIES } = await import('./dictionaries');
  const worker = new Worker(new URL('./spellWorker.js', import.meta.url), { type: 'module' });
  let nextId = 0;
  const waiting = new Map();
  worker.onmessage = ({ data }) => {
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) call?.reject(new Error(data.error));
    else call?.resolve(data.result);
  };
  const ask = (message) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
  try {
    await ask({ type: 'load', ...DICTIONARIES[language] });
  } catch (err) {
    worker.terminate();
    throw err;
  }
  return {
    check: (words) => ask({ type: 'check', words }),
    suggest: (word) => ask({ type: 'suggest', word }),
    close: () => worker.terminate(),
  };
}

let engineFactory = workerEngine;
let engine = null; // { language, ready: Promise<engine> }
const known = new Map(); // word -> misspelled?
const queued = new Set();
let flushTimer = null;
const listeners = new Set();

function notify() {
  listeners.forEach((listener) => listener());
}

function reset() {
  clearTimeout(flushTimer);
  flushTimer = null;
  engine?.ready.then((e) => e.close(), () => {});
  engine = null;
  known.clear();
  queued.clear();
}

function engineFor(language) {
  if (engine?.language !== language) {
    reset();
    const ready = engineFactory(language);
    engine = { language, ready };
    // Without a dictionary (offline the first time...) nothing is underlined.
    ready.catch((err) => console.warn('Spellcheck unavailable:', err?.message));
  }
  return engine;
}

function flush() {
  flushTimer = null;
  const current = engine;
  const words = [...queued];
  queued.clear();
  if (!current || !words.length) return;
  current.ready
    .then((e) => e.check(words))
    .then((wrong) => {
      if (engine !== current) return;
      const set = new Set(wrong);
      for (const word of words) known.set(word, set.has(word));
      notify();
    })
    .catch(() => {});
}

// Whether `word` is misspelled: true / false, or undefined until the checker knows (listeners
// are told then). Always false while our checker isn't the one checking.
export function misspelled(word) {
  const language = spellcheckLanguage();
  if (!language || hasWord(word)) return false;
  engineFor(language);
  if (known.has(word)) return known.get(word);
  if (!queued.has(word)) {
    queued.add(word);
    flushTimer ??= setTimeout(flush, 0);
  }
  return undefined;
}

// -> whether `word` is misspelled, asking the checker if it doesn't know yet (a right-click on
// a word not seen before, in a plain text box).
export async function checkWord(word) {
  const answer = misspelled(word);
  if (answer !== undefined) return answer;
  try {
    const wrong = await (await engine.ready).check([word]);
    return wrong.includes(word);
  } catch {
    return false;
  }
}

// -> up to 5 corrections for `word` ([] when there are none, or no checker).
export async function suggestions(word) {
  const language = spellcheckLanguage();
  if (!language) return [];
  try {
    return await (await engineFor(language).ready).suggest(word);
  } catch {
    return [];
  }
}

export function subscribeChecker(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

subscribeSpellcheck(() => {
  if (engine && engine.language !== spellcheckLanguage()) reset();
  notify();
});
subscribeDictionary(notify);

// Tests: `factory(language)` -> Promise<engine>.
export function setEngineFactory(factory) {
  reset();
  engineFactory = factory ?? workerEngine;
}
