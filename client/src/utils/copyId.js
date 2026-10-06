import { faIdCard } from '@fortawesome/free-solid-svg-icons';
import { t } from '../i18n';

// Copy … ID items for right-click menus (users, channels, threads, categories, guilds), as in
// Discord, giving the ids bots see in the bot API (see Ids in docs/bots.md): ours as they are,
// except categories, a table of their own, offset by CATEGORY_ID_BASE (server/discord.js).

export const CATEGORY_ID_BASE = 2 ** 40;

const LABELS = {
  user: 'common.copyId.user',
  channel: 'common.copyId.channel',
  thread: 'common.copyId.thread',
  category: 'common.copyId.category',
  guild: 'common.copyId.guild',
};

// The id a bot knows `kind` `id` by, as a string.
export function apiId(kind, id) {
  return String(kind === 'category' ? CATEGORY_ID_BASE + Number(id) : id);
}

// A ContextMenu item copying it (and saying so).
export function copyIdItem(kind, id) {
  return {
    key: `copy-${kind}-id`,
    label: t(LABELS[kind]),
    icon: faIdCard,
    onSelect: async () => {
      await navigator.clipboard.writeText(apiId(kind, id));
      return t('common.copyId.copied');
    },
  };
}
