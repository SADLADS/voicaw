import { useEffect, useRef } from 'react';
import { checkChat, saveChat } from '../services/offlineCopy';

// How long a chat rests before what changed is saved.
const SAVE_DELAY_MS = 500;

// Keeps the offline copy (services/offlineCopy.js) of chat `chat` following what its hook shows:
// `messages` and `hasMore` as the hook has them, `live` while they came from the server (never
// while showing the copy itself). Once per opening, the older saved parts are checked against
// the server (`fetchRanges`, the hook's search source's). Online, this is all it does: nothing
// shown waits for it.
export function useOfflineChat({ chat, messages, hasMore, live, fetchRanges }) {
  const state = useRef({ previous: null, pending: null, timer: null, queue: Promise.resolve(), checked: null });
  const fetchRangesRef = useRef(fetchRanges);
  fetchRangesRef.current = fetchRanges;

  // Saves what's waiting, after any save still running (one at a time).
  const flush = () => {
    const s = state.current;
    clearTimeout(s.timer);
    const job = s.pending;
    s.pending = null;
    if (!job) return;
    s.queue = s.queue.then(async () => {
      try {
        const previous = s.previous?.chat === job.chat ? s.previous.map : null;
        const map = await saveChat(job.chat, job.messages, { complete: !job.hasMore, previous });
        s.previous = map ? { chat: job.chat, map } : null;
        if (s.checked !== job.chat) {
          s.checked = job.chat;
          const ids = job.messages.map((m) => m.id).filter(Number.isInteger);
          if (ids.length) await checkChat(job.chat, Math.min(...ids), job.fetchRanges);
        }
      } catch (err) {
        console.warn('Failed to save the offline copy', err);
      }
    });
  };

  useEffect(() => {
    if (!chat || !live) return;
    const s = state.current;
    s.pending = { chat, messages, hasMore, fetchRanges: (ranges) => fetchRangesRef.current(ranges) };
    clearTimeout(s.timer);
    // The chat just opened is saved at once (a reload or a closed tab soon after shouldn't
    // lose it); later changes once they rest.
    if (s.checked !== chat) flush();
    else s.timer = setTimeout(flush, SAVE_DELAY_MS);
  }, [chat, messages, hasMore, live]);

  // Leaving the chat (or the page) saves what's waiting at once.
  useEffect(() => {
    if (!chat) return undefined;
    const s = state.current;
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
      if (s.checked === chat) s.checked = null;
    };
  }, [chat]);
}
