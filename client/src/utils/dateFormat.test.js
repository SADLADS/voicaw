import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatTime } from './dateFormat';

const when = new Date(2026, 8, 3, 16, 7, 5); // 3 Sep 2026, 16:07:05 local

describe('dateFormat', () => {
  it('formats dates each way', () => {
    expect(formatDate(when, { date: 'dmy' })).toBe('03/09/2026');
    expect(formatDate(when, { date: 'mdy' })).toBe('09/03/2026');
    expect(formatDate(when, { date: 'ymd' })).toBe('2026-09-03');
    expect(formatDate(when, { date: 'auto' })).toBe(when.toLocaleDateString());
  });

  it('formats times in 12 or 24 hours, with seconds if asked', () => {
    expect(formatTime(when, { time: '24' })).toBe('16:07');
    expect(formatTime(when, { time: '24', seconds: true })).toBe('16:07:05');
    expect(formatTime(when, { time: '12' }).replace(/\s/g, ' ').toUpperCase()).toMatch(/^4:07 PM$/);
  });

  it('puts both together, and takes unix milliseconds too', () => {
    expect(formatDateTime(when.getTime(), { date: 'ymd', time: '24' })).toBe('2026-09-03, 16:07');
  });
});
