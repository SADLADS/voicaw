import React, { useMemo } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHashtag } from '@fortawesome/free-solid-svg-icons';
import MessageSearch from '../MessageSearch';
import { NsfwChannelContext } from '../../contexts';
import { searchGuildMessages } from '../../services/guildService';
import { toChatMessage } from '../../hooks/useChannel';
import { usePreferences } from '../../utils/preferences';
import { t } from '../../i18n';

// Searching the guild, server side (routes/guildSearch.js), in MessageSearch's box: words plus
// from:, mentions:, in: and has:. Each result says its channel; Jump (`onJump`, given the
// message with its channel_id) opens the message in its channel.
export default function GuildSearch({ guild, members, user, isMobile, onJump, reactionNames, mentionRoles, nameColors }) {
  const channels = useMemo(() => guild.channels.filter((c) => c.type === 'text' || c.type === 'voice'), [guild.channels]);
  const channelName = (id) => guild.channels.find((c) => c.id === id)?.name ?? t('guilds.search.unknownChannel');
  // A result from an NSFW channel has its media covered, as in the channel, and isn't shown at
  // all until you've said you're 18 or over (NsfwAgeGate).
  const isNsfw = (id) => Boolean(guild.channels.find((c) => c.id === id)?.nsfw);
  const { adultConfirmed } = usePreferences();

  const runSearch = async (params, { sort, offset }) => {
    const data = await searchGuildMessages(guild.id, { ...params, sort_order: sort, ...(offset ? { offset } : {}) });
    return { total: data.total_results, messages: data.messages.map(toChatMessage) };
  };

  return (
    <MessageSearch
      scopeId={guild.id}
      placeholder={t('guilds.search.placeholder', { name: guild.name })}
      label={t('guilds.search.label')}
      intro={t('guilds.search.intro')}
      members={members}
      channels={channels}
      user={user}
      isMobile={isMobile}
      onJump={onJump}
      runSearch={runSearch}
      resultTop={(msg) => (
        <div className="search-result-channel">
          <FontAwesomeIcon icon={faHashtag} /> {channelName(msg.channel_id)}
        </div>
      )}
      resultHidden={(msg) => !adultConfirmed && isNsfw(msg.channel_id)}
      hiddenNote={(count) => t('guilds.search.nsfwHidden', { count })}
      wrapContent={(msg, node) => <NsfwChannelContext.Provider value={isNsfw(msg.channel_id)}>{node}</NsfwChannelContext.Provider>}
      reactionNames={reactionNames}
      mentionRoles={mentionRoles}
      myRoleIds={guild.my_role_ids}
      nameColors={nameColors}
    />
  );
}
