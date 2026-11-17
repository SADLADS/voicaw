// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '../utils/api';
import { cleanPastedLinks, refreshLinkRules, resetLinkRulesForTests } from './linkRules';
import { setPrivacyPref } from '../utils/privacy';

vi.mock('../utils/api', () => ({ default: { get: vi.fn() } }));

const LINK = 'https://shop.test/x?ref=1&utm_source=a';

beforeEach(() => {
  localStorage.clear();
  resetLinkRulesForTests();
  api.get.mockReset();
  setPrivacyPref('cleanLinks', true);
});

describe('services/linkRules', () => {
  it('does nothing while the setting is off', () => {
    setPrivacyPref('cleanLinks', false);
    expect(cleanPastedLinks(LINK)).toBe(LINK);
    expect(api.get).not.toHaveBeenCalled();
  });

  it("uses the built-in rules, then adds the server's list, kept on the device", async () => {
    api.get.mockResolvedValue({ data: { enabled: true, list: null } });
    expect(cleanPastedLinks(LINK)).toBe('https://shop.test/x?ref=1');
    await refreshLinkRules();
    // Not downloaded yet on the server: asked again next time.
    api.get.mockResolvedValue({ data: { enabled: true, etag: 'e1', list: { v: 1, rules: [{ p: 'ref', h: ['shop.test'] }] } } });
    await refreshLinkRules();
    expect(cleanPastedLinks(LINK)).toBe('https://shop.test/x');
    expect(JSON.parse(localStorage.getItem('linkRules')).etag).toBe('e1');

    // Checked again only after 12 hours, with the etag it has.
    await refreshLinkRules();
    expect(api.get).toHaveBeenCalledTimes(2);
    api.get.mockResolvedValue({ data: { enabled: true, etag: 'e1', unchanged: true } });
    await refreshLinkRules({ force: true });
    expect(api.get).toHaveBeenLastCalledWith('/link-rules', { params: { have: 'e1' } });
    resetLinkRulesForTests();
    expect(cleanPastedLinks(LINK)).toBe('https://shop.test/x');
  });

  it('drops the list when an admin turned it off, and keeps it when the server fails', async () => {
    api.get.mockResolvedValue({ data: { enabled: true, etag: 'e1', list: { v: 1, rules: [{ p: 'ref' }] } } });
    await refreshLinkRules({ force: true });
    api.get.mockRejectedValue(new Error('offline'));
    await refreshLinkRules({ force: true });
    expect(cleanPastedLinks(LINK)).toBe('https://shop.test/x');
    api.get.mockResolvedValue({ data: { enabled: false } });
    await refreshLinkRules({ force: true });
    expect(cleanPastedLinks(LINK)).toBe('https://shop.test/x?ref=1');
  });
});
