import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { formatTimestamp, timestampsToText, timestampText, validTimestamp } from './timestamps';
import { formatRelative, setDateSettings } from './dateFormat';
import { mentionsToText } from './mentions';
import { rehypeMentions } from './rehypeMentions';

// 9 October 2026, 18:07:05 local.
const when = new Date(2026, 9, 9, 18, 7, 5);
const unix = Math.floor(when.getTime() / 1000);

beforeEach(() => {
  vi.stubGlobal('navigator', { language: 'en-GB' });
  setDateSettings({ date: 'dmy', time: '24' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setDateSettings({ date: 'auto', time: 'auto' });
});

describe('timestamps', () => {
  it("formats each of Discord's styles in the reader's time and chosen formats", () => {
    expect(formatTimestamp(unix, 't')).toBe('18:07');
    expect(formatTimestamp(unix, 'T')).toBe('18:07:05');
    expect(formatTimestamp(unix, 'd')).toBe('09/10/2026');
    expect(formatTimestamp(unix, 'D')).toBe('9 October 2026');
    expect(formatTimestamp(unix, 'f')).toBe('9 October 2026, 18:07');
    expect(formatTimestamp(unix, '')).toBe('9 October 2026, 18:07');
    expect(formatTimestamp(unix, 'F')).toBe('Friday 9 October 2026, 18:07');
    setDateSettings({ time: '12' });
    expect(formatTimestamp(unix, 't').replace(/\s/g, ' ').toUpperCase()).toBe('6:07 PM');
  });

  it('says how far off a relative one is, counting from now', () => {
    const now = when.getTime();
    expect(formatTimestamp(unix + 8 * 3600, 'R', now)).toBe('in 8 hours');
    expect(formatTimestamp(unix + 7.6 * 3600, 'R', now)).toBe('in 8 hours');
    expect(formatTimestamp(unix - 90, 'R', now)).toBe('2 minutes ago');
    expect(formatTimestamp(unix + 10, 'R', now)).toBe('in a few seconds');
    expect(formatTimestamp(unix - 10, 'R', now)).toBe('a few seconds ago');
    expect(formatRelative(now + 23 * 3600 * 1000, now)).toBe('in 1 day');
    expect(formatRelative(now - 40 * 86400 * 1000, now)).toBe('1 month ago');
    expect(formatRelative(now + 400 * 86400 * 1000, now)).toBe('in 1 year');
  });

  it('writes and checks them as Discord does', () => {
    expect(timestampText(1791565200, 'R')).toBe('<t:1791565200:R>');
    expect(timestampText(1791565200, '')).toBe('<t:1791565200>');
    expect(validTimestamp('1791565200')).toBe(true);
    expect(validTimestamp('9999999999999')).toBe(false);
  });

  it('reads as text in plain-text places, leaving anything else as typed', () => {
    expect(timestampsToText(`at <t:${unix}:t> (<t:${unix}>) <t:${unix}:x> <t:9999999999999:t>`))
      .toBe(`at 18:07 (9 October 2026, 18:07) <t:${unix}:x> <t:9999999999999:t>`);
    expect(mentionsToText(`<@1> at <t:${unix}:t>`, { 1: 'anna' })).toBe('@anna at 18:07');
  });

  it('marks them in messages, but not inside code', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'text', value: `see <t:${unix}:R> or <t:${unix}>` },
        { type: 'element', tagName: 'code', children: [{ type: 'text', value: `<t:${unix}:R>` }] },
      ],
    };
    rehypeMentions()(tree);
    const spans = tree.children.filter((n) => n.tagName === 'span');
    expect(spans.map((s) => s.properties)).toEqual([
      { className: ['timestamp'], dataTimestamp: String(unix), dataTimestampStyle: 'R' },
      { className: ['timestamp'], dataTimestamp: String(unix), dataTimestampStyle: '' },
    ]);
    expect(tree.children.at(-1).children[0].value).toBe(`<t:${unix}:R>`);
  });
});
