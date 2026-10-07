import React, { useState } from 'react';
import ConfirmDialog from './guild/ConfirmDialog';
import { addFriend, relationOf, removeFriend, useFriends } from '../utils/friends';
import { isBot, isDeleted, getProfile } from '../utils/profiles';
import { t } from '../i18n';

// Someone's friend button on a profile card (utils/friends.js): Add friend, Request sent (click
// to cancel), Accept friend request, or Remove friend (asks first). Nothing for bots or deleted
// accounts, which can't be friends.
export default function FriendButton({ userId, name }) {
  const friends = useFriends();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!friends.loaded || isBot(userId) || isDeleted(getProfile(userId))) return null;
  const relation = relationOf(friends, userId);
  const run = (action) => {
    setFailed(false);
    action().catch(() => setFailed(true));
  };

  let button;
  if (relation === 'friend') {
    button = (
      <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setConfirming(true)}>
        {t('friends.remove')}
      </button>
    );
  } else if (relation === 'outgoing') {
    button = (
      <button type="button" className="btn btn-outline-secondary btn-sm" title={t('friends.cancel')} onClick={() => run(() => removeFriend(userId))}>
        {t('friends.requestSent')}
      </button>
    );
  } else {
    button = (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => run(() => addFriend(userId))}>
        {relation === 'incoming' ? t('friends.acceptRequest') : t('friends.addFriend')}
      </button>
    );
  }

  return (
    <>
      {button}
      {failed && <span className="error-text friend-button-error">{t('friends.actionFailed')}</span>}
      {confirming && (
        <ConfirmDialog
          title={t('friends.removeConfirmTitle', { name })}
          message={t('friends.removeConfirm')}
          confirmLabel={t('friends.remove')}
          onConfirm={() => removeFriend(userId)}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
