import React, { useMemo } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faNoteSticky } from '@fortawesome/free-solid-svg-icons';
import '../assets/css/dms.css';
import ChatPane from './ChatPane';
import { useConversation } from '../hooks/useConversation';
import { addReaction, removeReaction } from '../services/dmService';
import { encryptReaction, reactionContext } from '../services/encryptionService';
import { nameOf, useProfiles } from '../utils/profiles';

// Your notes (/dm/notes): a DM to yourself, end-to-end encrypted with a key only your own key
// pair derives (see useConversation's `notes`). Everything a DM has but calls and key checks.
export default function Notes({ user }) {
  const id = user?.id != null ? String(user.id) : undefined;
  const conversation = useConversation({ id, user, chatUser: user, notes: true });
  const { sharedKey } = conversation;
  const profilesVersion = useProfiles();
  const reactionNames = useMemo(
    () => ({ [user?.id]: nameOf(user) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, user?.username, profilesVersion]
  );
  const people = useMemo(() => (user ? [user] : []), [user]);

  const saveReaction = async (msg, emoji) => {
    const content = await encryptReaction(
      emoji, sharedKey, reactionContext(msg.id, user.id, msg.sender_id, msg.recipient_id)
    );
    return addReaction(msg.id, content);
  };

  return (
    <div id="dm-main" className="notes-main" data-current-user-id={user?.id}>
      <h4 className="chat-recipient-header">
        <FontAwesomeIcon icon={faNoteSticky} className="notes-header-icon" />
        Notes
        <span className="chat-recipient-status">Only you can read these</span>
      </h4>
      {id && (
        <ChatPane
          chatId="notes"
          chatName="Notes"
          user={user}
          conversation={conversation}
          reactionsReady={Boolean(sharedKey)}
          saveReaction={saveReaction}
          deleteReaction={removeReaction}
          reactionNames={reactionNames}
          people={people}
          emptyText="Nothing here yet. Keep notes, links and files for yourself: they're end-to-end encrypted."
        />
      )}
    </div>
  );
}
