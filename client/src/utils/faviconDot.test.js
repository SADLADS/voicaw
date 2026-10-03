// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFaviconDot, setFaviconDot } from './faviconDot';

const DOTTED = 'data:image/png;base64,dotted';

describe('setFaviconDot', () => {
  let link;
  beforeEach(() => {
    resetFaviconDot();
    link = document.createElement('link');
    link.rel = 'icon';
    link.setAttribute('href', '/favicon.ico');
    document.head.appendChild(link);
    // jsdom has no canvas or image decoding.
    vi.stubGlobal('Image', class {
      set src(_) { queueMicrotask(() => this.onload()); }
    });
    const ctx = { drawImage() {}, beginPath() {}, arc() {}, fill() {} };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(DOTTED);
  });
  afterEach(() => {
    link.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the dotted icon while unread and puts the original back after', async () => {
    await setFaviconDot(true);
    expect(link.getAttribute('href')).toBe(DOTTED);
    await setFaviconDot(false);
    expect(link.getAttribute('href')).toBe('/favicon.ico');
    await setFaviconDot(true);
    expect(link.getAttribute('href')).toBe(DOTTED);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(1); // drawn once
  });

  it('leaves the icon alone when read again before the drawing finishes', async () => {
    const drawing = setFaviconDot(true);
    setFaviconDot(false);
    await drawing;
    expect(link.getAttribute('href')).toBe('/favicon.ico');
  });

  it('keeps the plain icon if the dot cannot be drawn', async () => {
    HTMLCanvasElement.prototype.getContext.mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setFaviconDot(true);
    expect(link.getAttribute('href')).toBe('/favicon.ico');
  });
});
