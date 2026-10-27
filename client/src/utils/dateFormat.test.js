import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDate, formatDateTime, formatLongDate, formatTime, parseDate } from './dateFormat';

const when = new Date(2026, 8, 3, 16, 7, 5); // 3 Sep 2026, 16:07:05 local

afterEach(() => vi.unstubAllGlobals());

describe('dateFormat', () => {
  it('formats dates each way', () => {
    expect(formatDate(when, { date: 'dmy' })).toBe('03/09/2026');
    expect(formatDate(when, { date: 'mdy' })).toBe('09/03/2026');
    expect(formatDate(when, { date: 'ymd' })).toBe('2026-09-03');
    expect(formatDate(when, { date: 'auto' })).toBe(when.toLocaleDateString(navigator.language));
  });

  it("is automatically the browser's way, or British without a language", () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(formatDateTime(when, { date: 'auto', time: 'auto' }).replace(/\s/g, ' ')).toBe('9/3/2026, 4:07 PM');
    vi.stubGlobal('navigator', { language: '' });
    expect(formatDateTime(when, { date: 'auto', time: 'auto' })).toBe('03/09/2026, 16:07');
  });

  it('reads typed dates back, in the order they are shown', () => {
    const day = (y, m, d) => new Date(y, m - 1, d).getTime();
    expect(parseDate('2026-09-03', { date: 'dmy' }).getTime()).toBe(day(2026, 9, 3));
    expect(parseDate('03/09/2026', { date: 'dmy' }).getTime()).toBe(day(2026, 9, 3));
    expect(parseDate('09/03/2026', { date: 'mdy' }).getTime()).toBe(day(2026, 9, 3));
    expect(parseDate('3.9.2026', { date: 'dmy' }).getTime()).toBe(day(2026, 9, 3));
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(parseDate('9/3/2026', { date: 'auto' }).getTime()).toBe(day(2026, 9, 3));
    expect(parseDate('31/02/2026', { date: 'dmy' })).toBe(null);
    expect(parseDate('yesterday')).toBe(null);
    expect(parseDate('1/2/26', { date: 'dmy' })).toBe(null);
  });

  it('formats times in 12 or 24 hours, with seconds if asked', () => {
    expect(formatTime(when, { time: '24' })).toBe('16:07');
    expect(formatTime(when, { time: '24', seconds: true })).toBe('16:07:05');
    expect(formatTime(when, { time: '12' }).replace(/\s/g, ' ').toUpperCase()).toMatch(/^4:07 PM$/);
  });

  it('puts both together, and takes unix milliseconds too', () => {
    expect(formatDateTime(when.getTime(), { date: 'ymd', time: '24' })).toBe('2026-09-03, 16:07');
  });

  it('writes the month out for day dividers, in the chosen order', () => {
    vi.stubGlobal('navigator', { language: '' });
    expect(formatLongDate(when, { date: 'auto' })).toBe('3 September 2026');
    expect(formatLongDate(when, { date: 'dmy' })).toBe('3 September 2026');
    expect(formatLongDate(when, { date: 'mdy' })).toBe('September 3, 2026');
    expect(formatLongDate(when, { date: 'ymd' })).toBe('2026-09-03');
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(formatLongDate(when, { date: 'auto' })).toBe('September 3, 2026');
  });
});
