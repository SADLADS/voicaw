import { useContext, useEffect, useMemo } from 'react';
import { ChannelMentionContext, LayoutContext } from '../contexts';
import { useFriends, visibleInDmList } from '../utils/friends';
import { useBlocked } from '../utils/blocks';
import { isDeleted, nameOf, useProfiles } from '../utils/profiles';
import { groupTitle } from '../utils/groupDisplay';
import { has, PERMISSIONS } from '../utils/permissions';
import { t } from '../i18n';

// The chats you can send something to (ForwardDialog, ShareDialog): your notes, then people and
// groups in the DM list's order (latest message first; no one blocked), then every guild's text
// channels you may send in, in the rail's order (the guilds not opened yet are loaded once).
// Each is { key, chatId (ChatPane's), path, kind: 'notes' | 'dm' | 'group' | 'channel', name,
// person | group | channel, guildName, at }.
export function useChatDestinations(user) {
  useProfiles();
  const { users = [], groupList, guildList } = useContext(LayoutContext) ?? {};
  const { loadAll: loadAllGuilds } = useContext(ChannelMentionContext) ?? {};
  const friends = useFriends();
  const blocked = useBlocked();

  useEffect(() => { loadAllGuilds?.(); }, [loadAllGuilds]);

  return useMemo(() => {
    const list = [{ key: 'notes', chatId: 'notes', path: '/dm/notes', kind: 'notes', name: t('chat.notes.title') }];
    const people = users
      .filter((person) => String(person.id) !== String(user.id) && !isDeleted(person) && !blocked.has(Number(person.id)))
      .filter((person) => visibleInDmList(friends, person, null))
      .map((person) => ({ key: `u-${person.id}`, chatId: String(person.id), path: `/dm/${person.id}`, kind: 'dm', person, name: nameOf(person), at: person.last_timestamp ?? 0 }));
    const groups = (groupList?.groups ?? [])
      .map((group) => ({ key: `g-${group.id}`, chatId: `group-${group.id}`, path: `/dm/g/${group.id}`, kind: 'group', group, name: groupTitle(group, user), at: group.last_timestamp ?? 0 }));
    list.push(...[...people, ...groups].sort((a, b) => b.at - a.at));
    for (const summary of guildList?.guilds ?? []) {
      const guild = guildList.layouts?.[summary.id];
      for (const channel of guild?.channels ?? []) {
        if (channel.type !== 'text' || !has(channel.my_permissions, PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES)) continue;
        list.push({
          key: `c-${channel.id}`, chatId: `channel-${channel.id}`, path: `/guild/${summary.id}/${channel.id}`, kind: 'channel',
          channel, name: channel.name, guildName: guild.name ?? summary.name,
        });
      }
    }
    return list;
  }, [users, user, blocked, friends, groupList?.groups, guildList?.guilds, guildList?.layouts]);
}

// Whether `destination` matches what was typed in the search box (lower case, trimmed).
export function matchesDestination(destination, query) {
  if (!query) return true;
  return [destination.name, destination.person?.username, destination.guildName].some((s) => s?.toLowerCase().includes(query));
}
