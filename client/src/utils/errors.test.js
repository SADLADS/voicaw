import { describe, expect, it } from 'vitest';
import { describeError, errorDetail, errorKind, errorText, ERROR_KINDS } from './errors';
import { t } from '../i18n';

// What axios rejects with.
const axiosError = ({ status, data, code, method = 'get', url = '/dm-messages/2?limit=50' } = {}) => Object.assign(
  new Error(status ? `Request failed with status code ${status}` : 'Network Error'),
  { isAxiosError: true, code, config: { method, url }, response: status ? { status, data } : undefined },
);

describe('errorKind', () => {
  it('tells whose problem it is', () => {
    expect(errorKind(axiosError({ code: 'ERR_NETWORK' }))).toBe('offline');
    expect(errorKind(axiosError({ status: 502, data: '<html>' }))).toBe('offline');
    expect(errorKind(axiosError({ status: 504 }))).toBe('offline');
    expect(errorKind(axiosError({ status: 503, data: '<html>' }))).toBe('offline');
    expect(errorKind(axiosError({ code: 'ECONNABORTED' }))).toBe('timeout');
    expect(errorKind(axiosError({ status: 500, data: { error: 'Internal server error' } }))).toBe('server');
    expect(errorKind(axiosError({ status: 503, data: { error: "Voice isn't set up yet" } }))).toBe('server');
    expect(errorKind(axiosError({ status: 401 }))).toBe('session');
    expect(errorKind(axiosError({ status: 403 }))).toBe('forbidden');
    expect(errorKind(axiosError({ status: 404 }))).toBe('gone');
    expect(errorKind(axiosError({ status: 429 }))).toBe('rate');
    expect(errorKind(axiosError({ status: 400 }))).toBe('rejected');
    expect(errorKind(new TypeError('Failed to fetch'))).toBe('offline');
    expect(errorKind(new Error('This device has no encryption keys.'))).toBe('device');
  });
});

describe('errorText', () => {
  it("never shows axios's own words", () => {
    for (const err of [axiosError({ code: 'ERR_NETWORK' }), axiosError({ status: 500 }), axiosError({ code: 'ECONNABORTED' })]) {
      expect(errorText(err)).not.toMatch(/Network Error|status code|timeout of/);
    }
    expect(errorText(axiosError({ code: 'ERR_NETWORK' }))).toBe(t('errors.text.offline'));
    expect(errorText(axiosError({ status: 500, data: { error: 'Internal server error' } }))).toBe(t('errors.text.server'));
  });

  it("keeps the server's own reason for its rules, with a fallback", () => {
    expect(errorText(axiosError({ status: 403, data: { error: 'Missing permissions' } }))).toBe('Missing permissions');
    expect(errorText(axiosError({ status: 403 }))).toBe(t('errors.text.forbidden'));
    expect(errorText(axiosError({ status: 400, data: { error: 'Invalid input' } }))).toBe('Invalid input');
    expect(errorText(axiosError({ status: 404, data: '' }))).toBe(t('errors.text.gone'));
    expect(errorText(axiosError({ status: 503, data: { error: "Voice isn't set up yet" } }))).toBe("Voice isn't set up yet");
  });

  it("keeps logging in's reason for a 401; a lost login says logged out", () => {
    expect(errorText(axiosError({ status: 401, data: { error: 'Wrong two-factor code' } }))).toBe('Wrong two-factor code');
    expect(errorText(axiosError({ status: 401, data: { error: 'Missing or invalid Authorization header' } }))).toBe(t('errors.text.session'));
    expect(errorText(axiosError({ status: 401 }))).toBe(t('errors.text.session'));
  });

  it('uses the fallback for device errors and reasonless refusals only', () => {
    expect(errorText(new Error('could not establish pc connection'), 'Couldn\'t connect.')).toBe('Couldn\'t connect.');
    expect(errorText(axiosError({ status: 400, data: {} }), 'Couldn\'t save.')).toBe('Couldn\'t save.');
    expect(errorText(axiosError({ status: 400, data: { error: 'Too long' } }), 'Couldn\'t save.')).toBe('Too long');
    expect(errorText(axiosError({ code: 'ERR_NETWORK' }), 'Couldn\'t save.')).toBe(t('errors.text.offline'));
  });

  it("passes on the device's own errors, already in words", () => {
    expect(errorText(new Error('Its keys are missing.'))).toBe('Its keys are missing.');
    expect(errorText('Already words')).toBe('Already words');
    expect(errorText(null)).toBe(t('errors.text.unknown'));
  });

  it('has words for every kind', () => {
    for (const kind of ERROR_KINDS.filter((k) => k !== 'device')) expect(t(`errors.text.${kind}`)).not.toContain('errors.');
  });
});

describe('describeError', () => {
  it('says whether trying again can help, with details for a bug report', () => {
    const now = new Date(2026, 10, 16, 17, 11, 2).getTime();
    const offline = describeError(axiosError({ code: 'ERR_NETWORK' }), now);
    expect(offline).toMatchObject({ kind: 'offline', retryable: true });
    expect(offline.detail).toMatch(/^ERR_NETWORK · GET \/dm-messages\/2 · .*17:11:02/);
    expect(describeError(axiosError({ status: 403 })).retryable).toBe(false);
    expect(errorDetail(axiosError({ status: 500, method: 'post', url: 'https://api.voicaw.com/api/dm-send' }), now))
      .toMatch(/^500 · POST \/api\/dm-send · /);
    expect(describeError('words')).toMatchObject({ kind: 'device', text: 'words', detail: null });
  });
});
