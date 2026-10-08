// A YouTube player from youtube-nocookie.com, driven over the messages its embed page
// understands (what YouTube's iframe API script does, without loading that script: it would
// run YouTube's code in our page, next to the keys). Used by Watch Together
// (components/voice/WatchPartyPlayer.jsx).
//
// We say we're listening once the frame loads (and again until it answers); it then sends
// `infoDelivery` messages (currentTime, playerState, duration...) and the events we asked
// for. Commands are { event: 'command', func, args }.

export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

// YouTube's player states.
export const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

let nextId = 1;

export function embedUrl(videoId, { start = 0, autoplay = false, origin } = {}) {
  const params = new URLSearchParams({
    enablejsapi: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    playsinline: '1',
    rel: '0',
    iv_load_policy: '3',
    start: String(Math.floor(start)),
    autoplay: autoplay ? '1' : '0',
  });
  // The frame answers to this origin; our desktop app's voicaw:// pages have none it accepts.
  if (origin && /^https?:/.test(origin)) params.set('origin', origin);
  return `${EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params}`;
}

export class YouTubeEmbed {
  // `onChange(info)` whenever something the frame reports changes.
  constructor(iframe, { onChange } = {}) {
    this.iframe = iframe;
    this.id = nextId++;
    this.onChange = onChange;
    this.info = { ready: false, playerState: STATE.UNSTARTED, currentTime: 0, timeAt: 0, duration: 0, error: null, muted: false };
    this.listening = null;
    this.handleMessage = this.handleMessage.bind(this);
    // The frame's answers come to the window it's in: a popped-out player's is its own.
    this.host = iframe.ownerDocument?.defaultView ?? window;
    this.host.addEventListener('message', this.handleMessage);
    this.handleLoad = () => this.startListening();
    iframe.addEventListener('load', this.handleLoad);
  }

  post(message) {
    this.iframe.contentWindow?.postMessage(JSON.stringify({ ...message, id: this.id, channel: 'widget' }), EMBED_ORIGIN);
  }

  // Until the frame answers, say so every 250 ms (it may not be listening itself yet).
  startListening() {
    clearInterval(this.listening);
    this.info = { ...this.info, ready: false };
    const say = () => this.post({ event: 'listening' });
    say();
    this.listening = setInterval(say, 250);
  }

  command(func, ...args) {
    this.post({ event: 'command', func, args });
  }

  handleMessage(event) {
    if (event.origin !== EMBED_ORIGIN || event.source !== this.iframe.contentWindow) return;
    let data;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const changes = {};
    if (!this.info.ready) {
      clearInterval(this.listening);
      this.listening = null;
      changes.ready = true;
      for (const name of ['onStateChange', 'onError']) this.command('addEventListener', name);
    }
    if ((data.event === 'infoDelivery' || data.event === 'initialDelivery') && data.info) {
      const { info } = data;
      if (Number.isFinite(info.currentTime)) {
        changes.currentTime = info.currentTime;
        changes.timeAt = performance.now();
      }
      if (Number.isFinite(info.playerState)) changes.playerState = info.playerState;
      if (Number.isFinite(info.duration)) changes.duration = info.duration;
      if (typeof info.muted === 'boolean') changes.muted = info.muted;
    } else if (data.event === 'onStateChange' && Number.isFinite(data.info)) {
      changes.playerState = data.info;
      if (data.info === STATE.PLAYING) changes.error = null;
    } else if (data.event === 'onError') {
      changes.error = data.info ?? true;
    }
    if (Object.keys(changes).length === 0) return;
    this.info = { ...this.info, ...changes };
    this.onChange?.(this.info);
  }

  // Where the video is now (the last report moved on by the time since, while playing).
  currentTime() {
    const { currentTime, timeAt, playerState } = this.info;
    if (playerState !== STATE.PLAYING) return currentTime;
    return currentTime + (performance.now() - timeAt) / 1000;
  }

  load(videoId, start, play) {
    this.info = { ...this.info, duration: 0, error: null, currentTime: start, timeAt: performance.now() };
    this.command(play ? 'loadVideoById' : 'cueVideoById', { videoId, startSeconds: start });
  }

  play() { this.command('playVideo'); }
  pause() { this.command('pauseVideo'); }

  seek(seconds) {
    this.info = { ...this.info, currentTime: seconds, timeAt: performance.now() };
    this.command('seekTo', seconds, true);
  }

  // 0–100, muted at 0.
  setVolume(volume) {
    if (volume <= 0) {
      this.command('mute');
    } else {
      this.command('unMute');
      this.command('setVolume', Math.round(volume));
    }
  }

  destroy() {
    clearInterval(this.listening);
    this.host.removeEventListener('message', this.handleMessage);
    this.iframe.removeEventListener('load', this.handleLoad);
  }
}
