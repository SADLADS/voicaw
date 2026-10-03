import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhone, faThumbtack, faUsers } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/dms.css';
import '../../assets/css/voice.css';
import '../../assets/css/groups.css';
import { ConfigContext, InteractionContext, LayoutContext } from '../../contexts';
import ChatPane from '../ChatPane';
import GroupMembers from './GroupMembers';
import GroupCallPanel from './GroupCallPanel';
import { useGroupConversation } from '../../hooks/useGroupConversation';
import { useCall } from '../../hooks/useCall';
import { acceptChangedKeys } from '../../services/groupKeys';
import { noteGroupCall, startGroupCall } from '../../voice/callClient';
import { groupTitle } from '../../utils/groupDisplay';
import { nameOf, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const SHOW_MEMBERS_KEY = 'showGroupMembers';

// A group DM (/dm/g/:groupId): header (name, call, members), the group's call, key problems
// (someone's security key changed), and the chat (ChatPane over useGroupConversation).
export default function GroupDm({ user }) {
  const { groupId } = useParams();
  const { users, groupList } = useContext(LayoutContext);
  const { voiceEnabled } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);
  const call = useCall();
  const conversation = useGroupConversation({ groupId, user, onRead: groupList.refresh });
  const { group } = conversation;
  const summary = groupList.groups.find((g) => g.id === groupId) ?? group?.detail;
  const [showMembers, setShowMembers] = useState(() => {
    try {
      return !isMobile && localStorage.getItem(SHOW_MEMBERS_KEY) !== 'false';
    } catch {
      return !isMobile;
    }
  });
  const [accepting, setAccepting] = useState(false);

  // The pinned messages list, under its header button (null: closed).
  const [pinsAnchor, setPinsAnchor] = useState(null);
  const closePins = useCallback(() => setPinsAnchor(null), []);
  const togglePins = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPinsAnchor((open) => (open ? null : rect));
  };

  useEffect(() => setPinsAnchor(null), [groupId]);

  useEffect(() => {
    if (group) noteGroupCall(groupId, group.detail.call);
  }, [group, groupId]);

  const profilesVersion = useProfiles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const names = useMemo(() => new Map((group?.detail.users ?? []).map((u) => [u.id, nameOf(u)])), [group, profilesVersion]);
  const reactionNames = useMemo(() => Object.fromEntries(names), [names]);
  const problems = group?.problems ?? [];
  const changed = problems.filter((p) => p.kind === 'changed');

  function toggleMembers() {
    setShowMembers((show) => {
      try {
        if (!isMobile) localStorage.setItem(SHOW_MEMBERS_KEY, String(!show));
      } catch {
        // Not remembered, then.
      }
      return !show;
    });
  }

  return (
    <div id="dm-main" className="group-dm" data-current-user-id={user?.id}>
      <h4 className="chat-recipient-header">
        <span className="group-dm-title">{summary ? groupTitle(summary, user) : t('groups.dm.group')}</span>
        {voiceEnabled && group && (
          <button
            type="button"
            className="chat-call-button"
            aria-label={t('groups.dm.startCall')}
            title={call ? t('groups.dm.alreadyInCall') : t('groups.dm.startCallHint')}
            disabled={Boolean(call) || problems.length > 0}
            onClick={() => startGroupCall(groupId)}
          >
            <FontAwesomeIcon icon={faPhone} />
          </button>
        )}
        {group && (
          <button
            type="button"
            className={`chat-call-button pins-button${pinsAnchor ? ' active' : ''}`}
            aria-label={t('groups.dm.pinnedMessages')}
            aria-pressed={Boolean(pinsAnchor)}
            title={t('groups.dm.pinnedMessages')}
            onClick={togglePins}
          >
            <FontAwesomeIcon icon={faThumbtack} />
          </button>
        )}
        <button
          type="button"
          className={`chat-call-button group-members-button${showMembers ? ' active' : ''}`}
          aria-label={showMembers ? t('groups.dm.hideMembers') : t('groups.dm.showMembers')}
          aria-pressed={showMembers}
          onClick={toggleMembers}
        >
          <FontAwesomeIcon icon={faUsers} />
        </button>
      </h4>

      {group && <GroupCallPanel groupId={groupId} names={names} user={user} />}

      {problems.length > 0 && (
        <div className="contact-key-warning" role="alert">
          <p>
            {t('groups.dm.keyChanged', { count: problems.length, names: problems.map((p) => nameOf(p.user)).join(', ') })}
          </p>
          {changed.length === problems.length ? (
            <button
              type="button"
              className="btn btn-sm btn-warning"
              disabled={accepting}
              onClick={async () => {
                setAccepting(true);
                await acceptChangedKeys(user, changed.map((p) => p.user));
                await conversation.reload();
                setAccepting(false);
              }}
            >
              {t('groups.dm.acceptKeys', { count: changed.length })}
            </button>
          ) : (
            <p className="vc-hint">{t('groups.dm.removeAndAdd')}</p>
          )}
        </div>
      )}

      <div className="group-dm-body">
        <div className="group-dm-chat">
          <ChatPane
            pollKind="group"
            chatId={`group-${groupId}`}
            chatName={summary ? groupTitle(summary, user) : null}
            user={user}
            conversation={conversation}
            reactionsReady={Boolean(group)}
            saveReaction={conversation.saveReaction}
            deleteReaction={conversation.deleteReaction}
            reactionNames={reactionNames}
            people={summary?.members}
            canSend={Boolean(group) && problems.length === 0}
            cantSendText={group ? t('groups.dm.cantSend') : t('common.loading')}
            emptyText={t('groups.dm.empty')}
            pinsAnchor={pinsAnchor}
            onClosePins={closePins}
          />
        </div>
        {showMembers && group && (
          <GroupMembers group={group} user={user} users={users} onClose={isMobile ? () => setShowMembers(false) : undefined} />
        )}
      </div>
    </div>
  );
}
