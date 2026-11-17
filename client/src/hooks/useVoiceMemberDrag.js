import { useCallback, useRef, useState } from 'react';
import { usePointerDrag } from './usePointerDrag';

// Dragging someone in a voice channel onto another voice channel in the channel list
// (GuildSidebar), like Discord's Move Members: for the guild's owner and Administrators, on a
// computer (a phone's long press on someone is their volume). The person's row stays put, a
// copy of it follows the pointer, and the voice channel under it is highlighted; dropping
// there calls `move(userId, channelId)` (the server moves them, and their apps follow).
//
// Drop targets are found under the pointer: any element with `data-voice-drop="<channel id>"`
// (a voice channel's row, and the list of who's in it). `listRef` is the scrolling channel
// list, which scrolls near its edges. `drag` is { userId, name, channelId, x, y, overChannelId }
// while dragging (`channelId`: where they are now).

const EDGE_PX = 32;
const EDGE_SCROLL_PX = 12;

// The voice channel at viewport point (x, y), or null.
export function voiceChannelAt(x, y) {
  const id = document.elementFromPoint?.(x, y)?.closest?.('[data-voice-drop]')?.dataset.voiceDrop;
  return id ? Number(id) : null;
}

export function useVoiceMemberDrag({ enabled, listRef, move }) {
  const [drag, setDrag] = useState(null);
  const latest = useRef({ enabled, move });
  latest.current = { enabled, move };

  const show = useCallback((item, { x, y }) => {
    const list = listRef.current;
    if (list) {
      const box = list.getBoundingClientRect();
      if (y < box.top + EDGE_PX) list.scrollTop -= EDGE_SCROLL_PX;
      else if (y > box.bottom - EDGE_PX) list.scrollTop += EDGE_SCROLL_PX;
    }
    setDrag({ ...item, x, y, overChannelId: voiceChannelAt(x, y) });
  }, [listRef]);

  const { pointerDown } = usePointerDrag({
    canDrag: () => latest.current.enabled,
    onStart: show,
    onMove: show,
    onCancel: () => setDrag(null),
    onDrop: (item, { x, y }) => {
      setDrag(null);
      const channelId = voiceChannelAt(x, y);
      if (channelId == null || channelId === item.channelId) return;
      latest.current.move(item.userId, channelId);
    },
  });

  // Spread on the row of someone in voice channel `channelId`.
  const dragProps = useCallback((userId, name, channelId) => (enabled ? {
    'data-voice-draggable': '',
    onPointerDown: (e) => {
      if (e.pointerType === 'touch') return;
      pointerDown({ userId: Number(userId), name, channelId: Number(channelId) }, e);
    },
  } : {}), [enabled, pointerDown]);

  return { drag, dragProps };
}
