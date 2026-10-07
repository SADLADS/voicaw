import { describe, it, expect } from 'vitest';
import { isAndroidApp, ongoingNotification, sameOngoing, saveToDownloads, SAVE_CHUNK } from './android';

function fakePlugin({ failAppend = false } = {}) {
  const calls = [];
  const record = (name, result) => async (args) => {
    calls.push([name, args]);
    if (name === 'saveFileAppend' && failAppend) throw new Error('disk full');
    return result;
  };
  return {
    calls,
    saveFileStart: record('saveFileStart', { id: 'f1' }),
    saveFileAppend: record('saveFileAppend'),
    saveFileFinish: record('saveFileFinish', { opened: true }),
    saveFileCancel: record('saveFileCancel'),
  };
}

const labels = { mute: 'Mute', unmute: 'Unmute', hangUp: 'Hang up' };

describe('the Android app bridge', () => {
  it('is only there in the app', () => {
    expect(isAndroidApp()).toBe(false);
  });

  it('shows an ongoing-call notification only while in voice', () => {
    expect(ongoingNotification({ status: 'idle' }, { title: 'x', status: 'y', labels })).toBeNull();
    expect(ongoingNotification({ status: 'connected', callId: 'c1', selfMute: false, selfDeaf: true }, { title: 'Call with Sam', status: 'Connected', labels }))
      .toEqual({ title: 'Call with Sam', text: 'Connected', muted: true, inCall: true, labels });
    expect(ongoingNotification({ status: 'connecting', callId: null }, { title: 'General', status: 'Connecting…', labels }))
      .toMatchObject({ inCall: false, muted: false });
  });

  it('only updates the notification when what it shows changes', () => {
    const a = { title: 'General', text: 'Connected', muted: false, inCall: false, labels };
    expect(sameOngoing(a, { ...a, labels: { ...labels } })).toBe(true);
    expect(sameOngoing(a, { ...a, muted: true })).toBe(false);
    expect(sameOngoing(null, null)).toBe(true);
    expect(sameOngoing(a, null)).toBe(false);
  });

  it('sends a saved file to the app in base64 pieces', async () => {
    const bytes = new Uint8Array(SAVE_CHUNK + 10).map((_, i) => i % 251);
    const plugin = fakePlugin();
    const result = await saveToDownloads(new Blob([bytes], { type: 'image/png' }), 'cat.png', { open: true }, plugin);
    expect(result).toEqual({ opened: true });
    expect(plugin.calls.map(([name]) => name)).toEqual(['saveFileStart', 'saveFileAppend', 'saveFileAppend', 'saveFileFinish']);
    expect(plugin.calls[0][1]).toEqual({ name: 'cat.png', type: 'image/png' });
    const sent = plugin.calls.slice(1, 3).flatMap(([, { data }]) => [...atob(data)].map((c) => c.charCodeAt(0)));
    expect(Uint8Array.from(sent)).toEqual(bytes);
    expect(plugin.calls[3][1]).toEqual({ id: 'f1', open: true });
  });

  it('throws away a file it could not finish sending', async () => {
    const plugin = fakePlugin({ failAppend: true });
    await expect(saveToDownloads(new Blob(['hello']), 'a.txt', {}, plugin)).rejects.toThrow('disk full');
    expect(plugin.calls.map(([name]) => name)).toEqual(['saveFileStart', 'saveFileAppend', 'saveFileCancel']);
  });
});
