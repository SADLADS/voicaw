// A group DM's title: its name, or the other members' names (like Discord).
export function groupTitle(group, me) {
  if (group?.name) return group.name;
  const others = (group?.members ?? []).filter((m) => m.id !== me?.id).map((m) => m.username);
  if (others.length === 0) return 'Just you';
  if (others.length <= 3) return others.join(', ');
  return `${others.slice(0, 3).join(', ')} and ${others.length - 3} more`;
}
