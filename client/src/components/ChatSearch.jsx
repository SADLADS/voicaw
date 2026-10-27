import React from 'react';
import MessageSearch from './MessageSearch';
import { ENCRYPTED_HAS_VALUES } from '../utils/messageSearch';
import { t } from '../i18n';

const KEYS = ['from', 'mentions', 'has', 'before', 'after'];
const PAGE = 25;

// Searching a DM, group DM or your notes, which only this device can read: the chat hook's
// `searchMessages` (services/searchIndex.js) reads and keeps an encrypted copy of the history
// first, showing how far it's got. No in: (one chat) and no has:embed. `people` are who
// from: and mentions: suggest; Jump (`onJump(msg)`) scrolls the chat to it.
export default function ChatSearch({ scopeId, chatName, conversation, people, user, isMobile, onJump, reactionNames }) {
  // Pages are counted from the start each time (the device's copy is read again, not the server).
  const runSearch = async (params, { sort, offset, signal, onProgress }) => {
    const { total, messages } = await conversation.searchMessages(params, {
      sort, limit: offset + PAGE, sync: offset === 0, signal, onProgress,
    });
    return { total, messages: messages.slice(offset) };
  };

  return (
    <MessageSearch
      scopeId={scopeId}
      placeholder={chatName ? t('chat.search.placeholder', { name: chatName }) : t('common.search')}
      intro={t('chat.search.intro')}
      members={people}
      keys={KEYS}
      hasValues={ENCRYPTED_HAS_VALUES}
      user={user}
      isMobile={isMobile}
      onJump={onJump}
      runSearch={runSearch}
      reactionNames={reactionNames}
    />
  );
}
