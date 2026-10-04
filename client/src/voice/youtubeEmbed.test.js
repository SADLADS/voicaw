// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EMBED_ORIGIN, STATE, YouTubeEmbed, embedUrl } from './youtubeEmbed';

let iframe;
let posted;

function fromFrame(data, { origin = EMBED_ORIGIN, source = iframe.contentWindow } = {}) {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), origin, source }));
}

beforeEach(() => {
  vi.useFakeTimers();
  iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  posted = [];
  iframe.contentWindow.postMessage = (message, target) => posted.push({ message: JSON.parse(message), target });
});

afterEach(() => {
  iframe.remove();
  vi.useRealTimers();
});

describe('embedUrl', () => {
  it('asks for the scripting interface without YouTube\'s own controls', () => {
    const url = new URL(embedUrl('dQw4w9WgXcQ', { start: 12.7, autoplay: true, origin: 'https://app.voicaw.com' }));
    expect(url.origin).toBe(EMBED_ORIGIN);
    expect(url.pathname).toBe('/embed/dQw4w9WgXcQ');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      enablejsapi: '1', controls: '0', disablekb: '1', start: '12', autoplay: '1', origin: 'https://app.voicaw.com',
    });
    // The desktop app's voicaw:// pages: no origin.
    expect(new URL(embedUrl('dQw4w9WgXcQ', { origin: 'voicaw://app' })).searchParams.has('origin')).toBe(false);
  });
});

describe('YouTubeEmbed', () => {
  it('says it is listening until the frame answers, then follows what it reports', () => {
    const onChange = vi.fn();
    const embed = new YouTubeEmbed(iframe, { onChange });
    iframe.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(600);
    expect(posted.filter((p) => p.message.event === 'listening')).toHaveLength(3);
    expect(posted.every((p) => p.target === EMBED_ORIGIN && p.message.channel === 'widget')).toBe(true);

    fromFrame({ event: 'initialDelivery', info: { currentTime: 3, playerState: STATE.PLAYING, duration: 200, muted: false } });
    expect(embed.info).toMatchObject({ ready: true, currentTime: 3, playerState: STATE.PLAYING, duration: 200 });
    expect(onChange).toHaveBeenCalledWith(embed.info);
    // It asked for the events it needs, and stopped saying it's listening.
    const commands = posted.filter((p) => p.message.event === 'command').map((p) => p.message.args[0]);
    expect(commands).toEqual(['onStateChange', 'onError']);
    posted.length = 0;
    vi.advanceTimersByTime(1000);
    expect(posted).toEqual([]);

    fromFrame({ event: 'onStateChange', info: STATE.PAUSED });
    expect(embed.info.playerState).toBe(STATE.PAUSED);
    fromFrame({ event: 'onError', info: 150 });
    expect(embed.info.error).toBe(150);
    embed.destroy();
  });

  it('ignores messages from anywhere else', () => {
    const embed = new YouTubeEmbed(iframe);
    fromFrame({ event: 'infoDelivery', info: { currentTime: 50 } }, { origin: 'https://evil.example' });
    fromFrame({ event: 'infoDelivery', info: { currentTime: 50 } }, { source: window });
    window.dispatchEvent(new MessageEvent('message', { data: 'not json', origin: EMBED_ORIGIN, source: iframe.contentWindow }));
    expect(embed.info.ready).toBe(false);
    expect(embed.info.currentTime).toBe(0);
    embed.destroy();
  });

  it('sends commands, and guesses the time between reports while playing', () => {
    const embed = new YouTubeEmbed(iframe);
    fromFrame({ event: 'infoDelivery', info: { currentTime: 10, playerState: STATE.PLAYING } });
    posted.length = 0;
    embed.load('bbbbbbbbbbb', 30, true);
    embed.seek(42);
    embed.pause();
    embed.setVolume(0);
    embed.setVolume(55.4);
    expect(posted.map((p) => [p.message.func, p.message.args])).toEqual([
      ['loadVideoById', [{ videoId: 'bbbbbbbbbbb', startSeconds: 30 }]],
      ['seekTo', [42, true]],
      ['pauseVideo', []],
      ['mute', []],
      ['unMute', []],
      ['setVolume', [55]],
    ]);
    vi.advanceTimersByTime(2000);
    expect(embed.currentTime()).toBeCloseTo(44, 0);
    embed.destroy();
  });
});
