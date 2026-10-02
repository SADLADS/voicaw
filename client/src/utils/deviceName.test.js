import { describe, it, expect } from 'vitest';
import { describeDevice } from './deviceName';

describe('describeDevice', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Chrome on Windows', 'desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      'Edge on Windows', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari on macOS', 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux', 'desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iPhone', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      'Chrome on Android', 'mobile'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) voicaw/1.0.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36',
      'Voicaw desktop app on Linux', 'app'],
  ])('%s', (ua, name, kind) => {
    expect(describeDevice(ua)).toEqual({ name, kind });
  });

  it('copes with no user agent at all', () => {
    expect(describeDevice(null)).toEqual({ name: 'Unknown device', kind: 'desktop' });
    expect(describeDevice('curl/8.0')).toEqual({ name: 'Unknown device', kind: 'desktop' });
  });
});
