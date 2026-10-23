import { STATE } from './youtubeEmbed';

// A guild media server's video (Jellyfin or Emby, server/mediaServers.js) in a <video>, for
// Watch Together (components/voice/WatchPartyPlayer.jsx). The same face as YouTubeEmbed, so
// useWatchPartySync drives either: `info` ({ ready, playerState (YouTube's STATE), currentTime,
// timeAt, duration, error }), load, play, pause, seek, setVolume, destroy.
//
// `getStream(item)` asks our server where the item plays from ({ type: 'file' | 'hls', url },
// straight from the media server): a file is the <video>'s src; HLS (what the media server
// transcodes) goes through hls.js (loaded the first time it's needed) wherever it works, else the
// browser's own HLS (iPhones without MediaSource; newer Chromes have one too, but hls.js has
// been tried for longer). Until the video can play it says BUFFERING, so the sync
// doesn't take the wait for a browser refusing to autoplay.

const RETRIES = 4;
const RETRY_MS = 1500;

let hlsModule = null;
const loadHls = () => {
  hlsModule ??= import('hls.js').then((m) => m.default);
  return hlsModule;
};

export class MediaElementPlayer {
  constructor(video, { onChange, getStream } = {}) {
    this.video = video;
    this.onChange = onChange;
    this.getStream = getStream;
    this.hls = null;
    this.itemId = null;
    this.loading = 0; // which load() is current (a later one wins)
    this.info = { ready: true, playerState: STATE.UNSTARTED, currentTime: 0, timeAt: 0, duration: 0, error: null, muted: false };
    this.handlers = {
      playing: () => this.update({ playerState: STATE.PLAYING, error: null }),
      pause: () => this.update({ playerState: this.video.ended ? STATE.ENDED : STATE.PAUSED }),
      waiting: () => this.update({ playerState: STATE.BUFFERING }),
      seeking: () => this.update({ playerState: this.video.paused ? this.info.playerState : STATE.BUFFERING }),
      seeked: () => this.update({ playerState: this.video.paused ? STATE.PAUSED : STATE.PLAYING }),
      canplay: () => {
        if (this.info.playerState === STATE.BUFFERING || this.info.playerState === STATE.UNSTARTED) {
          this.update({ playerState: this.video.paused ? STATE.PAUSED : STATE.PLAYING });
        }
      },
      ended: () => this.update({ playerState: STATE.ENDED }),
      durationchange: () => this.update({ duration: Number.isFinite(this.video.duration) ? this.video.duration : 0 }),
      error: () => this.update({ error: true }),
    };
    for (const [name, handler] of Object.entries(this.handlers)) video.addEventListener(name, handler);
  }

  // Only videos from a media server: a YouTube one has its own player.
  accepts(item) {
    return item?.source === 'media';
  }

  update(changes) {
    this.info = { ...this.info, ...changes, currentTime: this.video.currentTime, timeAt: performance.now() };
    this.onChange?.(this.info);
  }

  currentTime() {
    return this.video.currentTime;
  }

  detach() {
    this.hls?.destroy();
    this.hls = null;
    this.video.removeAttribute('src');
    this.video.load();
  }

  async load(item, startAt, play) {
    let start = startAt;
    const ticket = ++this.loading;
    this.itemId = item.id;
    this.detach();
    this.update({ playerState: STATE.BUFFERING, duration: item.duration ?? 0, error: null });
    const began = performance.now();
    let stream;
    for (let attempt = 1; !stream; attempt++) {
      try {
        stream = await this.getStream(item);
      } catch (err) {
        if (ticket !== this.loading) return;
        // Just joined, the server may not know yet that you're in the channel (LiveKit tells it
        // a moment later), and the media server may be slow to answer: asked again a few times.
        const status = err?.response?.status;
        if (attempt < RETRIES && (status === 403 || status === 502 || status == null)) {
          await new Promise((resolve) => { setTimeout(resolve, RETRY_MS); });
          if (ticket !== this.loading) return;
          continue;
        }
        this.update({ playerState: STATE.UNSTARTED, error: err?.response?.data?.error ?? true });
        return;
      }
    }
    if (ticket !== this.loading) return;
    // A playing video moved on while its address was being asked for.
    if (play) start += (performance.now() - began) / 1000;
    const { video } = this;
    const Hls = stream.type === 'hls' ? await loadHls() : null;
    if (ticket !== this.loading) return;
    if (Hls && !Hls.isSupported() && !video.canPlayType('application/vnd.apple.mpegurl')) {
      this.update({ playerState: STATE.UNSTARTED, error: true });
      return;
    }
    if (Hls?.isSupported()) {
      // Starting at the party's point: the media server's transcode starts there too.
      const hls = new Hls({ startPosition: start, maxBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else this.update({ error: true });
      });
      this.hls = hls;
      hls.loadSource(stream.url);
      hls.attachMedia(video);
      // The element can keep the last video's position through the change, and hls.js would
      // load from there.
      video.currentTime = start;
    } else {
      video.src = stream.url;
      video.currentTime = start;
    }
    if (play) this.play();
  }

  play() {
    this.video.play().catch(() => {
      // Refused (autoplay) or interrupted by a new load: the sync tries again, and asks for a
      // click after a few refusals.
    });
  }

  pause() {
    this.video.pause();
  }

  seek(seconds) {
    this.video.currentTime = seconds;
    this.update({});
  }

  // 0–100, muted at 0.
  setVolume(volume) {
    this.video.muted = volume <= 0;
    this.video.volume = Math.min(1, Math.max(0, volume / 100));
  }

  destroy() {
    this.loading += 1;
    for (const [name, handler] of Object.entries(this.handlers)) this.video.removeEventListener(name, handler);
    this.detach();
  }
}
