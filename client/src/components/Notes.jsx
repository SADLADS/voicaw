import React, { useCallback, useContext, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faNoteSticky, faThumbtack } from '@fortawesome/free-solid-svg-icons';
import '../assets/css/dms.css';
import '../assets/css/voice.css';
import ChatPane from './ChatPane';
import ChatSearch from './ChatSearch';
import { InteractionContext } from '../contexts';
import PaneBackButton from './PaneBackButton';
import { useConversation } from '../hooks/useConversation';
import { addReaction, removeReaction } from '../services/dmService';
import { encryptReaction, reactionContext } from '../services/encryptionService';
import { nameOf, useProfiles } from '../utils/profiles';
import { t } from '../i18n';

// Your notes (/dm/notes): a DM to yourself, end-to-end encrypted with a key only your own key
// pair derives (see useConversation's `notes`). Everything a DM has but calls and key checks.
export default function Notes({ user }) {
  const id = user?.id != null ? String(user.id) : undefined;
  const conversation = useConversation({ id, user, chatUser: user, notes: true });
  const { sharedKey } = conversation;
  const { isMobile } = useContext(InteractionContext);
  // A search result to scroll to ({ messageId }; ChatPane's jumpTo).
  const [jumpTarget, setJumpTarget] = useState(null);
  const clearJump = useCallback(() => setJumpTarget(null), []);
  const profilesVersion = useProfiles();
  const reactionNames = useMemo(
    () => ({ [user?.id]: nameOf(user) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, user?.username, profilesVersion]
  );
  const people = useMemo(() => (user ? [user] : []), [user]);

  // The pinned notes list, under its header button (null: closed).
  const [pinsAnchor, setPinsAnchor] = useState(null);
  const closePins = useCallback(() => setPinsAnchor(null), []);
  const togglePins = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPinsAnchor((open) => (open ? null : rect));
  };

  const saveReaction = async (msg, emoji) => {
    const content = await encryptReaction(
      emoji, sharedKey, reactionContext(msg.id, user.id, msg.sender_id, msg.recipient_id)
    );
    return addReaction(msg.id, content);
  };

  return (
    <div id="dm-main" className="notes-main" data-current-user-id={user?.id}>
      <h4 className="chat-recipient-header">
        <PaneBackButton />
        <FontAwesomeIcon icon={faNoteSticky} className="notes-header-icon" />
        {t('chat.notes.title')}
        <span className="chat-recipient-status">{t('chat.notes.onlyYou')}</span>
        {sharedKey && (
          <button
            type="button"
            className={`chat-call-button pins-button${pinsAnchor ? ' active' : ''}`}
            aria-label={t('chat.pins.title')}
            aria-pressed={Boolean(pinsAnchor)}
            title={t('chat.pins.title')}
            onClick={togglePins}
          >
            <FontAwesomeIcon icon={faThumbtack} />
          </button>
        )}
        {sharedKey && (
          <ChatSearch
            scopeId="notes"
            chatName={t('chat.notes.title')}
            conversation={conversation}
            people={people}
            user={user}
            isMobile={isMobile}
            onJump={(msg) => setJumpTarget({ messageId: msg.id })}
            reactionNames={reactionNames}
          />
        )}
      </h4>
      {id && (
        <ChatPane
          pollKind="dm"
          chatId="notes"
          chatName={t('chat.notes.title')}
          user={user}
          conversation={conversation}
          reactionsReady={Boolean(sharedKey)}
          saveReaction={saveReaction}
          deleteReaction={removeReaction}
          reactionNames={reactionNames}
          people={people}
          pinsAnchor={pinsAnchor}
          onClosePins={closePins}
          jumpTo={jumpTarget}
          onJumped={clearJump}
          emptyText={t('chat.notes.empty')}
        />
      )}
    </div>
  );
}
