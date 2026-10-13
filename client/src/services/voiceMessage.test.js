import { describe, it, expect } from 'vitest';
import {
  decodeWaveform, encodeWaveform, findDuration, recordingType, relativeLevels, voiceFileName, waveformBars, waveformFrom,
  WAVEFORM_LENGTH,
} from './voiceMessage';
import { buildAttachmentUrl, parseAttachmentUrl } from './attachmentCrypto';
import { isVoiceMessage, summarizeAttachments, uploadNamesIn } from '../utils/attachmentMarkup';

const FILE = 'https://s3.test/uploads/0f0e.bin';
const voiceUrl = (waveform) => buildAttachmentUrl(FILE, {
  key: 'K'.repeat(43), type: 'audio/webm;codecs=opus', size: 1234, nonce: 'N'.repeat(16), duration: 3.24, waveform,
});

describe('voice messages', () => {
  it('records in the first type the browser has', () => {
    expect(recordingType((type) => type === 'audio/mp4')).toBe('audio/mp4');
    expect(recordingType(() => true)).toBe('audio/webm;codecs=opus');
    expect(recordingType(() => false)).toBe('');
    expect(voiceFileName('audio/webm;codecs=opus')).toBe('voice-message.webm');
    expect(voiceFileName('audio/ogg;codecs=opus')).toBe('voice-message.ogg');
    expect(voiceFileName('audio/mp4')).toBe('voice-message.m4a');
    expect(voiceFileName('')).toBe('voice-message.webm');
  });

  it('scales loudness to the loudest, linearly, leaving near-silence flat', () => {
    expect(relativeLevels([0.05, 0.2, 0.1, 0])).toEqual([0.25, 1, 0.5, 0]);
    // Loud speech (the microphone's auto gain) isn't all full height.
    expect(relativeLevels([0.3, 0.15, 0.6])).toEqual([0.5, 0.25, 1]);
    // Quieter than -36 dB at its loudest: not stretched.
    expect(relativeLevels([0.0015, 0.003])).toEqual([0.1, 0.2]);
    expect(relativeLevels([])).toEqual([]);
  });

  it('turns the loudness into a fixed-length waveform', () => {
    // Longer than the waveform: each byte the average (RMS) of its share, so one loud moment in
    // a quiet share doesn't fill it.
    const levels = Array.from({ length: 640 }, (_, i) => (i >= 100 && i < 110 ? 0.4 : i === 115 ? 0.4 : 0.1));
    const wave = waveformFrom(levels);
    expect(wave).toHaveLength(WAVEFORM_LENGTH);
    expect(wave[10]).toBe(255);
    expect(wave[11]).toBe(Math.round((Math.sqrt((9 * 0.01 + 0.16) / 10) / 0.4) * 255));
    expect(wave[12]).toBe(Math.round(0.25 * 255));
    // Shorter: levels repeat.
    expect([...waveformFrom([0, 0.5], 4)]).toEqual([0, 0, 255, 255]);
    expect([...waveformFrom([], 3)]).toEqual([0, 0, 0]);
  });

  it('draws any number of bars from a waveform', () => {
    expect(waveformBars(new Uint8Array([0, 255, 51, 0]), 2)).toEqual([0.5, 0.1]);
    expect(waveformBars([0, 0.5], 4, 1)).toEqual([0, 0, 0.5, 0.5]);
    expect(waveformBars(null, 3)).toEqual([0.15, 0.15, 0.15]);
  });

  it('puts the length and waveform in the attachment URL, and reads them back', () => {
    const waveform = waveformFrom(Array.from({ length: 30 }, (_, i) => i / 29));
    const url = voiceUrl(waveform);
    expect(url).toContain('&vm=1&wf=');
    const meta = parseAttachmentUrl(url);
    expect(meta).toMatchObject({ version: 2, voice: true, duration: 3.2, type: 'audio/webm;codecs=opus', size: 1234 });
    expect([...meta.waveform]).toEqual([...waveform]);
    expect(uploadNamesIn(`![voice-message.webm](${url})`)).toEqual(['0f0e.bin']);

    // Any other file: not a voice message.
    const plain = parseAttachmentUrl(buildAttachmentUrl(FILE, { key: 'K'.repeat(43), type: 'audio/ogg', size: 9, nonce: 'N'.repeat(16) }));
    expect(plain).toMatchObject({ voice: false, waveform: null });
  });

  it("doesn't take a malformed waveform", () => {
    expect(decodeWaveform(encodeWaveform(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
    expect(decodeWaveform('not base64!')).toBeNull();
    expect(decodeWaveform('A'.repeat(400))).toBeNull();
    expect(decodeWaveform(null)).toBeNull();
    const meta = parseAttachmentUrl(`${FILE}#v=2&k=K&t=audio%2Fwebm&s=1&n=${'N'.repeat(16)}&vm=1&wf=%3Cscript%3E`);
    expect(meta).toMatchObject({ voice: true, waveform: null });
  });

  it('is a voice message only alone, and says so in previews', () => {
    const embed = `![voice-message.webm](${voiceUrl(new Uint8Array([9, 9]))})`;
    expect(isVoiceMessage(embed)).toBe(true);
    expect(isVoiceMessage(`hi ${embed}`)).toBe(false);
    expect(isVoiceMessage(`${embed} ${embed}`)).toBe(false);
    expect(isVoiceMessage('![a.webm](https://s3.test/uploads/a.bin#v=2&k=K)')).toBe(false);
    expect(isVoiceMessage(null)).toBe(false);
    expect(summarizeAttachments(embed)).toBe('🎤 Voice message');
  });

  it("finds the length of a recording whose file doesn't say", async () => {
    const listeners = {};
    const audio = {
      duration: Infinity,
      currentTime: 0,
      addEventListener: (name, fn) => { listeners[name] = fn; },
      removeEventListener: (name) => { delete listeners[name]; },
    };
    const found = findDuration(audio);
    expect(audio.currentTime).toBe(1e101);
    audio.duration = 4.5;
    listeners.durationchange();
    await expect(found).resolves.toBe(4.5);
    expect(audio.currentTime).toBe(0);
    expect(listeners).toEqual({});
    await expect(findDuration({ duration: 2 })).resolves.toBe(2);
  });
});
