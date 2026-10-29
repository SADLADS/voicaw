import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { THEMES } from './theme';

// Every theme sets every colour token (voicaw.css, docs/client.md Themes). A token a theme leaves
// out falls back to Dark's silently, wrong on a light theme (Slack's live-editing carets were
// Dark's on its white page). Dark's block (:root) also holds the tokens every theme shares
// (sizes, motion, the QR code's colours); the colour tokens are the ones Light sets.
const css = readFileSync(new URL('../assets/css/voicaw.css', import.meta.url), 'utf8');

// The custom properties of the block opening at `[data-theme-preview="<name>"]` + `{`, and of
// any later block whose selector list names that preview with more after it (Slack's side).
function blocks() {
  const found = {};
  for (const match of css.matchAll(/\[data-theme-preview="([a-z]+)"\]([^{]*)\{/g)) {
    const [, name, rest] = match;
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') depth -= 1;
      end += 1;
    }
    const tokens = new Set([...css.slice(match.index + match[0].length, end - 1).matchAll(/(--vc-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const key = rest.trim() ? `${name} (part)` : name;
    found[key] = tokens;
  }
  return found;
}

describe('themes', () => {
  const themes = blocks();
  const colours = themes.light;

  it('every theme has a block of its own', () => {
    for (const theme of THEMES.filter((t) => t !== 'system')) expect(Object.keys(themes)).toContain(theme);
  });

  it('every theme sets every colour token', () => {
    for (const token of colours) expect([token, themes.dark.has(token)]).toEqual([token, true]);
    for (const theme of THEMES.filter((t) => t !== 'system' && t !== 'dark')) {
      expect([theme, [...colours].filter((token) => !themes[theme].has(token))]).toEqual([theme, []]);
      expect([theme, [...themes[theme]].filter((token) => !colours.has(token))]).toEqual([theme, []]);
    }
  });

  it("a theme's part (Slack's side) only sets colour tokens", () => {
    for (const [name, tokens] of Object.entries(themes).filter(([key]) => key.endsWith('(part)'))) {
      expect([name, [...tokens].filter((token) => !colours.has(token))]).toEqual([name, []]);
    }
  });
});
