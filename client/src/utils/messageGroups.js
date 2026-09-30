// How long after someone's message another of theirs still joins it (like Discord).
const GROUP_WINDOW_S = 7 * 60;

// Whether `msg` joins `prev` (the row above) without its own avatar, name and time: the same
// sender, within GROUP_WINDOW_S, the same day, and not a reply. A group DM message whose sender
// isn't verified always gets its own header, and nothing joins one (it mustn't pass as theirs).
export function continuesGroup(prev, msg) {
  if (!prev || prev.system || msg.system) return false;
  if (prev.sender_id !== msg.sender_id || msg.parent_message_id) return false;
  if (msg.unverified || msg.unsigned || prev.unverified || prev.unsigned) return false;
  const gap = msg.timestamp - prev.timestamp;
  if (!(gap >= 0 && gap < GROUP_WINDOW_S)) return false;
  return new Date(prev.timestamp * 1000).toDateString() === new Date(msg.timestamp * 1000).toDateString();
}
