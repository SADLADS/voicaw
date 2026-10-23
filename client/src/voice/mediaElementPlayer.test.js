// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const hls = vi.hoisted(() => ({ instances: [] }));
vi.mock('hls.js', () => {
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'media' };
    constructor(config) {
      this.config = config;
      hls.instances.push(this);
    }
    on() {}
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; }
    destroy() { this.destroyed = true; }
  }
  return { default: Hls };
});

import { MediaElementPlayer } from './mediaElementPlayer';
import { STATE } from './youtubeEmbed';

function makeVideo() {
  const video = document.createElement('video');
  video.play = vi.fn(() => Promise.resolve());
  video.pause = vi.fn();
  video.load = vi.fn();
  video.canPlayType = () => '';
  return video;
}

const item = { id: 5, source: 'media', media_id: 'film1', duration: 60 };

describe('MediaElementPlayer', () => {
  it('plays only media server videos', () => {
    const player = new MediaElementPlayer(makeVideo());
    expect(player.accepts(item)).toBe(true);
    expect(player.accepts({ id: 1, video_id: 'aaaaaaaaaaa' })).toBe(false);
    expect(player.accepts({ id: 1, source: 'youtube', video_id: 'aaaaaaaaaaa' })).toBe(false);
  });

  it('loads a file from where the server says, at the party\'s point', async () => {
    const video = makeVideo();
    const getStream = vi.fn().mockResolvedValue({ type: 'file', url: 'https://media.example/Videos/film1/stream?api_key=x' });
    const player = new MediaElementPlayer(video, { getStream });
    const loading = player.load(item, 12, true);
    // Waiting for the address isn't a refusal to play.
    expect(player.info.playerState).toBe(STATE.BUFFERING);
    await loading;
    expect(getStream).toHaveBeenCalledWith(item);
    expect(video.getAttribute('src')).toBe('https://media.example/Videos/film1/stream?api_key=x');
    expect(video.play).toHaveBeenCalled();
    player.setVolume(0);
    expect(video.muted).toBe(true);
    player.setVolume(50);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.5);
  });

  it('plays HLS through hls.js, starting where the party is', async () => {
    const video = makeVideo();
    const player = new MediaElementPlayer(video, { getStream: async () => ({ type: 'hls', url: 'https://media.example/videos/ep1/master.m3u8' }) });
    await player.load(item, 30, false);
    const instance = hls.instances.at(-1);
    expect(instance.config.startPosition).toBe(30);
    expect(instance.url).toBe('https://media.example/videos/ep1/master.m3u8');
    expect(instance.video).toBe(video);
    expect(video.play).not.toHaveBeenCalled();
    player.destroy();
    expect(instance.destroyed).toBe(true);
  });

  it('asks again while the server doesn\'t know yet that you joined', async () => {
    vi.useFakeTimers();
    const video = makeVideo();
    const getStream = vi.fn()
      .mockRejectedValueOnce({ response: { status: 403, data: { error: 'Join the voice channel first' } } })
      .mockResolvedValueOnce({ type: 'file', url: 'https://media.example/film' });
    const player = new MediaElementPlayer(video, { getStream });
    const loading = player.load(item, 0, true);
    await vi.advanceTimersByTimeAsync(2000);
    await loading;
    vi.useRealTimers();
    expect(getStream).toHaveBeenCalledTimes(2);
    expect(player.info.error).toBeNull();
    expect(video.getAttribute('src')).toBe('https://media.example/film');
  });

  it("says why when the server won't give the address", async () => {
    const onChange = vi.fn();
    const player = new MediaElementPlayer(makeVideo(), {
      onChange,
      getStream: async () => { throw { response: { status: 410, data: { error: "The guild's media server has changed" } } }; },
    });
    await player.load(item, 0, true);
    expect(player.info.error).toBe("The guild's media server has changed");
    expect(player.info.playerState).toBe(STATE.UNSTARTED);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ error: "The guild's media server has changed" }));
  });

  it('keeps only the latest of two loads', async () => {
    const video = makeVideo();
    let first;
    const getStream = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
      .mockResolvedValueOnce({ type: 'file', url: 'https://media.example/second' });
    const player = new MediaElementPlayer(video, { getStream });
    const a = player.load(item, 0, false);
    await player.load({ ...item, id: 6 }, 0, false);
    first({ type: 'file', url: 'https://media.example/first' });
    await a;
    expect(video.getAttribute('src')).toBe('https://media.example/second');
  });
});
