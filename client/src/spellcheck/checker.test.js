import { describe, it, expect, vi, afterEach } from 'vitest';
import { misspelled, setEngineFactory, subscribeChecker, suggestions } from './checker';
import { setSpellcheckEnabled } from '../utils/spellcheck';

vi.mock('./personalDictionary', () => ({
  hasWord: (word) => word.toLowerCase() === 'voicaw',
  subscribeDictionary: () => () => {},
}));

const WRONG = new Set(['wrold', 'teh', 'Voicaw']);

function fakeEngine() {
  const engine = {
    check: vi.fn(async (words) => words.filter((w) => WRONG.has(w))),
    suggest: vi.fn(async (word) => (word === 'teh' ? ['the', 'tea'] : [])),
    close: vi.fn(),
  };
  const factory = vi.fn(async () => engine);
  setEngineFactory(factory);
  return { engine, factory };
}

afterEach(() => {
  setEngineFactory(null);
  setSpellcheckEnabled(true);
});

describe('the spellchecker', () => {
  it('answers once the engine has checked, in one batch, and tells listeners', async () => {
    const { engine, factory } = fakeEngine();
    const heard = vi.fn();
    const stop = subscribeChecker(heard);
    expect(misspelled('hello')).toBeUndefined();
    expect(misspelled('wrold')).toBeUndefined();
    await vi.waitFor(() => expect(heard).toHaveBeenCalled());
    expect(engine.check).toHaveBeenCalledTimes(1);
    expect(engine.check).toHaveBeenCalledWith(['hello', 'wrold']);
    expect(misspelled('hello')).toBe(false);
    expect(misspelled('wrold')).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    stop();
  });

  it('never flags a word in your dictionary, and suggests corrections', async () => {
    const { engine } = fakeEngine();
    expect(misspelled('Voicaw')).toBe(false);
    expect(await suggestions('teh')).toEqual(['the', 'tea']);
    expect(engine.check).not.toHaveBeenCalled();
  });

  it('flags nothing when spellcheck is off', async () => {
    const { factory } = fakeEngine();
    setSpellcheckEnabled(false);
    expect(misspelled('wrold')).toBe(false);
    expect(await suggestions('teh')).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });
});
