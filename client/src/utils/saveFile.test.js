// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triggerDownload } from './saveFile';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function setUserAgent(ua) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

describe('triggerDownload', () => {
  let clicked;
  const realUserAgent = navigator.userAgent;

  beforeEach(() => {
    clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicked.push(this.download);
    });
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['x'], { type: 'image/jpeg' }) })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete navigator.canShare;
    delete navigator.share;
    setUserAgent(realUserAgent);
  });

  it('downloads the file everywhere but iOS', async () => {
    await triggerDownload('blob:x', 'cat.jpg');
    expect(navigator.share).not.toHaveBeenCalled();
    expect(clicked).toEqual(['cat.jpg']);
  });

  it('opens the share sheet for a picture on an iPhone, where Save Image reaches Photos', async () => {
    setUserAgent(IPHONE);
    await triggerDownload('blob:x', 'cat.jpg');
    const [{ files: [file] }] = navigator.share.mock.calls[0];
    expect(file.name).toBe('cat.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(clicked).toEqual([]);
  });

  it('does nothing more when the share sheet is closed', async () => {
    setUserAgent(IPHONE);
    navigator.share.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await triggerDownload('blob:x', 'cat.jpg');
    expect(clicked).toEqual([]);
  });

  it('downloads after all when the share sheet is refused', async () => {
    setUserAgent(IPHONE);
    navigator.share.mockRejectedValue(Object.assign(new Error('no gesture'), { name: 'NotAllowedError' }));
    await triggerDownload('blob:x', 'cat.jpg');
    expect(clicked).toEqual(['cat.jpg']);
  });

  it('downloads other files on an iPhone', async () => {
    setUserAgent(IPHONE);
    fetch.mockResolvedValue({ blob: async () => new Blob(['x'], { type: 'text/plain' }) });
    await triggerDownload('blob:x', 'codes.txt');
    expect(navigator.share).not.toHaveBeenCalled();
    expect(clicked).toEqual(['codes.txt']);
  });
});
