import { nameOf } from './profiles';
import { t } from '../i18n';

// A group DM's title: its name, or the other members' names (like Discord).
export function groupTitle(group, me) {
  if (group?.name) return group.name;
  const others = (group?.members ?? []).filter((m) => m.id !== me?.id).map((m) => nameOf(m));
  if (others.length === 0) return t('groups.title.justYou');
  if (others.length <= 3) return others.join(', ');
  return t('groups.title.andMore', { names: others.slice(0, 3).join(', '), count: others.length - 3 });
}
