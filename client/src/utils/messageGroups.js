// How long after someone's message another of theirs still joins it (like Discord).
const GROUP_WINDOW_S = 7 * 60;

// Whether `msg` joins `prev` (the row above) without its own avatar, name and time: the same
// sender, within GROUP_WINDOW_S, the same day, and not a reply. A group DM message whose sender
// isn't verified always gets its own header, and nothing joins one (it mustn't pass as theirs).
// A webhook's messages (sender 0) only join the same webhook's, sent under the same name and
// picture.
export function continuesGroup(prev, msg) {
  if (!prev || prev.system || msg.system) return false;
  if (prev.sender_id !== msg.sender_id || msg.parent_message_id) return false;
  if (msg.unverified || msg.unsigned || prev.unverified || prev.unsigned) return false;
  // Webhooks (no sender) group only with the same webhook, under the same name and picture.
  if ((prev.webhook_id || msg.webhook_id) && (prev.webhook_id !== msg.webhook_id ||
    prev.webhook_name !== msg.webhook_name || prev.webhook_avatar !== msg.webhook_avatar)) return false;
  const gap = msg.timestamp - prev.timestamp;
  if (!(gap >= 0 && gap < GROUP_WINDOW_S)) return false;
  return new Date(prev.timestamp * 1000).toDateString() === new Date(msg.timestamp * 1000).toDateString();
}
