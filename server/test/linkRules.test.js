import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { setSetting } = require('../appSettings');
const { FILTER_URL, parseFilter, parseLine, refreshLinkRules, resetLinkRulesForTests } = require('../linkRules');

const HEADER = '! Title: AdGuard URL Tracking filter\n! Version: 2.0.1\n! TimeUpdated: 2026-11-15T22:08:07+00:00\n';
// Enough filler rules to pass the "is this really the list" check.
const filler = (n) => Array.from({ length: n }, (_, i) => `$removeparam=filler${i}`).join('\n');

function filterResponse(text, status = 200) {
  return async (url) => {
    expect(url).toBe(FILTER_URL);
    return new Response(text, { status });
  };
}

describe('parseLine (AdGuard rules as ours)', () => {
  it('keeps the rules about links, in our format', () => {
    expect(parseLine('$removeparam=utm_id')).toEqual({ p: 'utm_id' });
    expect(parseLine('||x.com^$removeparam=s')).toEqual({ p: 's', h: ['x.com'] });
    expect(parseLine('||Example.com$removeparam')).toEqual({ p: '*', h: ['example.com'] });
    expect(parseLine('$removeparam=/^utm_custom\\d+/')).toEqual({ p: '/^utm_custom\\d+/' });
    expect(parseLine('$removeparam=epi,domain=microsoft.com|~store.microsoft.com')).toEqual({ p: 'epi', h: ['microsoft.com'], x: ['store.microsoft.com'] });
    expect(parseLine('@@||shop.test^$removeparam=ref')).toEqual({ p: 'ref', h: ['shop.test'], e: 1 });
    expect(parseLine('||site.test^$document,removeparam=x')).toEqual({ p: 'x', h: ['site.test'] });
    expect(parseLine('$removeparam=/a\\,b/i')).toEqual({ p: '/a,b/i' });
    const path = parseLine('||youtube.com/shorts/$removeparam=si');
    expect(path.p).toBe('si');
    expect(new RegExp(path.u, 'i').test('https://m.youtube.com/shorts/abc?si=1')).toBe(true);
    expect(new RegExp(path.u, 'i').test('https://youtube.com/watch?v=1')).toBe(false);
  });

  it("leaves out sites' own requests, negations, other kinds of rule and comments", () => {
    for (const line of [
      '! a comment',
      '',
      '[Adblock Plus 2.0]',
      'example.com##.ad',
      '||cdn.test^$script,removeparam=sid',
      '||cdn.test^$xmlhttprequest,removeparam=sid',
      '||go.test^$removeparam=~r',
      '@@||msn.com^$app=msedgewebview2.exe,removeparam=ocid',
      '/regex/$removeparam=x',
      '$removeparam=/(/',
      '||ads.test^',
    ]) expect(parseLine(line)).toBeNull();
  });
});

describe('parseFilter', () => {
  it('reads the header and drops repeats', () => {
    const parsed = parseFilter(`${HEADER}$removeparam=a\n$removeparam=a\r\n||b.test^$removeparam=c\n`);
    expect(parsed).toMatchObject({ title: 'AdGuard URL Tracking filter', version: '2.0.1', updated: '2026-11-15T22:08:07+00:00' });
    expect(parsed.rules).toEqual([{ p: 'a' }, { p: 'c', h: ['b.test'] }]);
  });
});

describe('GET /link-rules', () => {
  let token;
  const get = (query = '') => request(app).get(`/api/link-rules${query}`).set({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    resetLinkRulesForTests();
    await setSetting('linkRules', '');
    if (!token) {
      await registerUser(app, request, 'link-rules-user', 'pw-link-rules-1');
      token = (await loginUser(app, request, 'link-rules-user', 'pw-link-rules-1')).response.body.token;
    }
  });

  it('needs a login', async () => {
    expect((await request(app).get('/api/link-rules')).status).toBe(401);
  });

  it('serves the converted list, or only says unchanged for the etag the app has', async () => {
    expect((await get()).body).toEqual({ enabled: true, list: null });
    expect(await refreshLinkRules({ fetch: filterResponse(`${HEADER}||x.com^$removeparam=s\n${filler(300)}`) })).toBe(true);
    const { body } = await get();
    expect(body.enabled).toBe(true);
    expect(body.list).toMatchObject({ v: 1, version: '2.0.1', licence: 'GPL-3.0', source: 'https://github.com/AdguardTeam/AdguardFilters' });
    expect(body.list.rules[0]).toEqual({ p: 's', h: ['x.com'] });
    expect(body.list.rules).toHaveLength(301);

    // The list in this format is what the client's cleaner reads.
    const { cleanLink, compileRules } = await import('../../client/src/utils/linkCleaner.js');
    expect(cleanLink('https://x.com/a/status/1?s=20&filler7=1&keep=1', compileRules(body.list.rules))).toBe('https://x.com/a/status/1?keep=1');

    expect((await get(`?have=${body.etag}`)).body).toEqual({ enabled: true, etag: body.etag, unchanged: true });
  });

  it('keeps the last good list when a download looks wrong', async () => {
    await refreshLinkRules({ fetch: filterResponse(`${HEADER}${filler(1000)}`) });
    const { etag } = (await get()).body;
    for (const bad of [
      filterResponse('', 500),
      filterResponse(`! Title: Something else\n${filler(1000)}`),
      filterResponse(`${HEADER}${filler(150)}`),
      filterResponse(`${HEADER}${filler(450)}`), // under half of the 1000 before
      async () => { throw new Error('offline'); },
    ]) expect(await refreshLinkRules({ fetch: bad })).toBe(false);
    expect((await get()).body.etag).toBe(etag);
  });

  it("serves nothing when Settings → Admin turned it off", async () => {
    await refreshLinkRules({ fetch: filterResponse(`${HEADER}${filler(300)}`) });
    await setSetting('linkRules', 'off');
    expect((await get()).body).toEqual({ enabled: false });
  });
});
