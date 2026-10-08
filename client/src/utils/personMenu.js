import {
  faCheck, faCrown, faGavel, faMessage, faUserMinus, faUserPlus, faUserSlash, faUserXmark,
} from '@fortawesome/free-solid-svg-icons';
import { addFriend, getFriends, relationOf, removeFriend } from './friends';
import { isBlocked } from './blocks';
import { getProfile, isBot, isDeleted } from './profiles';
import { PERMISSIONS, has, memberRank } from './permissions';
import { copyIdItem } from './copyId';
import { openSafetyDialog, userSafetyItems } from './safetyDialogs';
import { t } from '../i18n';

// One menu for a person, wherever they're shown (a guild's member list, a message's picture or
// name, a mention...): right-clicked on a computer (PageMenus), held on a phone (a sheet, opened
// with openPersonMenu). Message, the friend item (Add / Accept / Cancel / Remove), in a guild
// Make Owner / Kick / Ban as your permissions and rank allow, Block / Report, then Copy User ID;
// only Copy User ID on yourself. What asks first opens through SafetyDialogs, since the menu
// closes on a pick.

// The guild open now (GuildView): { guild, members }, or null outside guilds.
let scope = null;
export function setPersonMenuGuild(next) {
  scope = next;
}

// Opens a conversation with someone (Layout, which keeps bots' conversations): (userId) => promise.
let messenger = null;
export function setPersonMessenger(next) {
  messenger = next;
}

// Opening the menu from code, as a sheet (a long press on a phone); PageMenus draws it.
let opener = null;
export function onOpenPersonMenu(listener) {
  opener = listener;
  return () => {
    if (opener === listener) opener = null;
  };
}
export function openPersonMenu(userId) {
  opener?.(userId);
}

function friendItem(userId, name) {
  const friends = getFriends();
  if (!friends.loaded || isBot(userId) || isDeleted(getProfile(userId)) || isBlocked(userId)) return null;
  const relation = relationOf(friends, userId);
  if (relation === 'friend') {
    return { key: 'remove-friend', label: t('app.personMenu.removeFriend'), icon: faUserMinus, onSelect: () => openSafetyDialog({ kind: 'unfriend', userId, name }) };
  }
  if (relation === 'outgoing') {
    return { key: 'cancel-friend', label: t('app.personMenu.cancelRequest'), icon: faUserXmark, onSelect: () => removeFriend(userId) };
  }
  if (relation === 'incoming') {
    return { key: 'accept-friend', label: t('app.personMenu.acceptRequest'), icon: faCheck, onSelect: () => addFriend(userId) };
  }
  return { key: 'add-friend', label: t('app.personMenu.addFriend'), icon: faUserPlus, onSelect: () => addFriend(userId) };
}

// Make Owner (the owner, not to a bot), Kick and Ban (with the permission, over someone you
// outrank), for a member of the guild open now.
function guildItems(userId, name, meId) {
  if (!scope?.guild) return [];
  const { guild, members } = scope;
  const member = members.find((m) => Number(m.id) === userId);
  if (!member) return [];
  const me = members.find((m) => Number(m.id) === Number(meId));
  const owner = Number(guild.owner);
  const outranks = userId !== owner && memberRank(guild, meId, me?.role_ids) > memberRank(guild, member.id, member.role_ids);
  const can = (bit) => has(guild.my_permissions, bit);
  const items = [];
  if (owner === Number(meId) && !member.bot) {
    items.push({ key: 'make-owner', label: t('guilds.memberList.makeOwner'), icon: faCrown, onSelect: () => openSafetyDialog({ kind: 'transfer', guild, userId, name }) });
  }
  if (can(PERMISSIONS.KICK_MEMBERS) && outranks) {
    items.push({ key: 'kick', label: t('guilds.memberList.kick.button'), icon: faUserSlash, danger: true, onSelect: () => openSafetyDialog({ kind: 'kick', guild, userId, name }) });
  }
  if (can(PERMISSIONS.BAN_MEMBERS) && outranks) {
    items.push({ key: 'ban', label: t('guilds.memberList.ban.button'), icon: faGavel, danger: true, onSelect: () => openSafetyDialog({ kind: 'ban', guild, userId, name }) });
  }
  return items;
}

// The menu's items for user `userId` (shown as `name`), as you (`meId`) see them.
export function personMenuItems(userId, name, meId) {
  if (userId == null) return [];
  const id = Number(userId);
  const groups = [];
  if (meId != null && id !== Number(meId)) {
    const first = [];
    if (messenger) first.push({ key: 'message', label: t('app.personMenu.message'), icon: faMessage, onSelect: () => messenger(id) });
    const friend = friendItem(id, name);
    if (friend) first.push(friend);
    groups.push(first, guildItems(id, name, meId), userSafetyItems(id, name, meId));
  }
  groups.push([copyIdItem('user', id)]);
  return groups.filter((group) => group.length).flatMap((group, i) => (i ? [{ separator: true }, ...group] : group));
}
