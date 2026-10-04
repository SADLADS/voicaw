import { useEffect, useRef, useState } from 'react';
import { STATE } from '../voice/youtubeEmbed';
import { expectedPosition, reportDuration } from '../voice/watchParty';

const CHECK_EVERY_MS = 500;
const DRIFT_PLAYING = 2; // seconds off before a playing video is moved back into step
const DRIFT_PAUSED = 0.75;
const RETRY_PLAY_MS = 1500;
const BLOCKED_AFTER = 3; // play commands ignored in a row: the browser won't autoplay

// Keeps `embed` (a YouTubeEmbed) on the party's video, at the point the server's clock says,
// playing or paused as the party is: twice a second it compares and, if it has to, loads, plays,
// pauses or seeks. Also tells the server how long a video is (the first player to know does) and
// sets the volume (0–100) once the frame is `ready`. Returns { blocked } (the browser wouldn't start it: a click on the
// player has to) and `retry()`, for that click. `initialItemId`: the item the frame was opened on.
export function useWatchPartySync({ embed, ready, party, guildId, channelId, volume, initialItemId = null }) {
  const latest = useRef(party);
  latest.current = party;
  const [blocked, setBlocked] = useState(false);
  const local = useRef({ itemId: null, lastPlay: 0, lastSeek: 0, attempts: 0 });

  useEffect(() => {
    if (!embed) return undefined;
    // The frame opens on its first video by itself (its address): not loaded a second time.
    local.current = { itemId: initialItemId, lastPlay: -Infinity, lastSeek: -Infinity, attempts: 0 };
    const check = () => {
      const p = latest.current;
      if (!p?.current || !embed.info.ready) return;
      const now = performance.now();
      const state = local.current;
      const expected = expectedPosition(p);

      if (state.itemId !== p.current.id) {
        state.itemId = p.current.id;
        state.attempts = 0;
        state.lastPlay = now;
        state.lastSeek = now;
        embed.load(p.current.video_id, expected, p.playing);
        return;
      }

      const { playerState, duration } = embed.info;
      if (duration > 0 && p.current.duration == null) reportDuration(guildId, channelId, p.current.id, duration);
      const drift = Math.abs(embed.currentTime() - expected);
      const atEnd = p.current.duration && expected >= p.current.duration - 0.5;

      if (p.playing) {
        if (playerState === STATE.PLAYING) {
          state.attempts = 0;
          setBlocked(false);
          if (drift > DRIFT_PLAYING && now - state.lastSeek > 3000) {
            state.lastSeek = now;
            embed.seek(expected);
          }
        } else if (playerState !== STATE.BUFFERING && !atEnd && now - state.lastPlay > RETRY_PLAY_MS) {
          state.lastPlay = now;
          state.attempts += 1;
          if (state.attempts >= BLOCKED_AFTER) setBlocked(true);
          if (drift > DRIFT_PAUSED) embed.seek(expected);
          embed.play();
        }
      } else {
        state.attempts = 0;
        setBlocked(false);
        if (playerState === STATE.PLAYING || playerState === STATE.BUFFERING) embed.pause();
        if (drift > DRIFT_PAUSED && now - state.lastSeek > 1000) {
          state.lastSeek = now;
          // Seeking a cued video starts it: cue it again at the new point instead.
          if (playerState === STATE.CUED || playerState === STATE.UNSTARTED) embed.load(p.current.video_id, expected, false);
          else embed.seek(expected);
        }
      }
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    check();
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first video only, when the frame is new
  }, [embed, guildId, channelId]);

  // A change from the server is acted on at once, not at the next check.
  useEffect(() => {
    if (!embed || !party?.current) return;
    local.current.lastPlay = -Infinity;
    local.current.lastSeek = -Infinity;
  }, [embed, party]);

  useEffect(() => {
    if (embed && ready) embed.setVolume(volume);
  }, [embed, ready, volume]);

  const retry = () => {
    if (!embed) return;
    local.current.attempts = 0;
    setBlocked(false);
    embed.seek(expectedPosition(latest.current));
    embed.play();
  };

  return { blocked, retry };
}
