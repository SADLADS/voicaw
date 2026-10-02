import { describe, it, expect } from 'vitest';
import { callLength, callLogText, parseCallLog } from './callLog';

const row = (data, extra = {}) => ({ system: 'call', content: JSON.stringify(data), ...extra });

describe('call log', () => {
  it('reads only call rows it understands', () => {
    expect(parseCallLog(row({ v: 1, outcome: 'ended', duration: 90, joined: [1, 2] }))).toEqual({ outcome: 'ended', duration: 90, joined: [1, 2] });
    expect(parseCallLog(row({ v: 2, outcome: 'ended' }))).toBeNull();
    expect(parseCallLog(row({ v: 1, outcome: 'exploded' }))).toBeNull();
    expect(parseCallLog({ system: 'call', content: 'not json' })).toBeNull();
    expect(parseCallLog({ system: 'poll_end', content: '' })).toBeNull();
    expect(parseCallLog(row({ v: 1, outcome: 'missed', duration: 'x', joined: 'y' }))).toEqual({ outcome: 'missed', duration: 0, joined: [] });
  });

  it('says how long a call lasted', () => {
    expect(callLength(0)).toBe('a few seconds');
    expect(callLength(59)).toBe('a few seconds');
    expect(callLength(119)).toBe('a minute');
    expect(callLength(12 * 60 + 40)).toBe('12 minutes');
    expect(callLength(3600)).toBe('an hour');
    expect(callLength(3600 + 5 * 60)).toBe('an hour and 5 minutes');
    expect(callLength(2 * 3600 + 60)).toBe('2 hours and 1 minute');
  });

  it('tells everyone the same about an answered call, and the caller apart when nobody picked up', () => {
    const names = { callerId: 1, caller: 'Alice', callee: 'Bob' };
    const ended = { outcome: 'ended', duration: 720, joined: [1, 2] };
    expect(callLogText(ended, { ...names, meId: 1 })).toEqual({ missed: false, text: 'Alice started a call that lasted 12 minutes.' });
    expect(callLogText(ended, { ...names, meId: 2 }).text).toBe('Alice started a call that lasted 12 minutes.');

    const missed = { outcome: 'missed', duration: 0, joined: [] };
    expect(callLogText(missed, { ...names, meId: 2 })).toEqual({ missed: true, text: 'You missed a call from Alice.' });
    expect(callLogText(missed, { ...names, meId: 1 }).text).toBe("Bob didn't answer.");
    expect(callLogText(missed, { ...names, meId: 1, group: true }).text).toBe('Nobody answered.');

    const declined = { outcome: 'declined', duration: 0, joined: [] };
    expect(callLogText(declined, { ...names, meId: 2 }).text).toBe('You missed a call from Alice.');
    expect(callLogText(declined, { ...names, meId: 1 }).text).toBe('Bob declined the call.');
  });
});
