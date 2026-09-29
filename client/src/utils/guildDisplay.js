// "Test Guild" -> "TG", "voicaw" -> "v": what a guild without an icon shows (like Discord).
export function guildInitials(name) {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => [...word][0])
    .join('')
    .slice(0, 3);
}

// Its channels grouped for the sidebar: first those without a category, then each category
// with its channels, all in order.
export function groupChannels(guild) {
  const channels = [...(guild?.channels ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const categories = [...(guild?.categories ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  return {
    uncategorized: channels.filter((c) => c.category_id == null || !categories.some((cat) => cat.id === c.category_id)),
    categories: categories.map((category) => ({
      ...category,
      channels: channels.filter((c) => c.category_id === category.id),
    })),
  };
}

// The channel a guild opens on: the last one viewed there (on this device) if it still
// exists, otherwise the first text channel.
export function defaultChannel(guild) {
  let remembered = null;
  try {
    remembered = localStorage.getItem(`guildChannel:${guild.id}`);
  } catch {
    // Storage unavailable.
  }
  const { uncategorized, categories } = groupChannels(guild);
  const ordered = [...uncategorized, ...categories.flatMap((c) => c.channels)];
  return ordered.find((c) => String(c.id) === remembered)
    ?? ordered.find((c) => c.type === 'text')
    ?? ordered[0]
    ?? null;
}

export function rememberChannel(guildId, channelId) {
  try {
    localStorage.setItem(`guildChannel:${guildId}`, String(channelId));
  } catch {
    // Storage unavailable.
  }
}

// The link to share for an invite code.
export function inviteLink(code) {
  return `${window.location.origin}/invite/${code}`;
}

// The invite code in something pasted: a whole link or just the code.
export function parseInviteCode(text) {
  const trimmed = (text ?? '').trim();
  const match = /\/invite\/([A-Za-z0-9]+)\/?$/.exec(trimmed);
  if (match) return match[1];
  return /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed : null;
}

// What to tell the user about a failed request: the server's message if it sent one.
export function errorMessage(err) {
  return err?.response?.data?.error || err?.message || 'Something went wrong.';
}
