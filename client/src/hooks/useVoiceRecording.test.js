// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const recorder = { stop: vi.fn(), cancel: vi.fn() };
let hearLevel;
vi.mock('../services/voiceMessage', async (importOriginal) => ({
  ...(await importOriginal()),
  startVoiceRecorder: async ({ onLevel }) => {
    hearLevel = onLevel;
    return recorder;
  },
}));

const letScreenGo = vi.fn();
vi.mock('../utils/keepScreenOn', () => ({ keepScreenOn: vi.fn(() => letScreenGo) }));

import { useVoiceRecording } from './useVoiceRecording';
import { keepScreenOn } from '../utils/keepScreenOn';

let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
function hide() {
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  hidden = false;
  vi.clearAllMocks();
});

async function recording(options) {
  recorder.stop.mockResolvedValue({ file: new Blob(['x']), duration: 3, waveform: new Uint8Array(64) });
  globalThis.URL.createObjectURL ??= () => 'blob:take';
  const hook = renderHook(() => useVoiceRecording({ onSend: vi.fn(), ...options }));
  await act(() => hook.result.current.start());
  act(() => hearLevel([0.1, 0.2], 3));
  await waitFor(() => expect(hook.result.current.phase).toBe('recording'));
  return hook;
}

describe('useVoiceRecording', () => {
  it('on a phone, leaving the app stops the recording and keeps it to listen to', async () => {
    const { result } = await recording({ stopWhenHidden: true });
    act(() => hide());
    await waitFor(() => expect(result.current.phase).toBe('review'));
    expect(recorder.stop).toHaveBeenCalled();
    expect(result.current.take.duration).toBe(3);
    expect(result.current.locked).toBe(true); // a hold let go later doesn't send it
  });

  it('keeps the screen on while recording, and lets it go once stopped', async () => {
    const { result } = await recording({});
    expect(keepScreenOn).toHaveBeenCalledTimes(1);
    expect(letScreenGo).not.toHaveBeenCalled();
    await act(() => result.current.stop());
    expect(result.current.phase).toBe('review');
    expect(letScreenGo).toHaveBeenCalledTimes(1);
  });

  it('on a computer, recording carries on out of sight', async () => {
    const { result } = await recording({});
    act(() => hide());
    expect(result.current.phase).toBe('recording');
    expect(recorder.stop).not.toHaveBeenCalled();
  });
});
