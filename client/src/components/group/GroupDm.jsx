import React, { useContext, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhone, faUsers } from '@fortawesome/free-solid-svg-icons';
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
        <span className="group-dm-title">{summary ? groupTitle(summary, user) : 'Group'}</span>
        {voiceEnabled && group && (
          <button
            type="button"
            className="chat-call-button"
            aria-label="Start a group call"
            title={call ? "You're already in a call" : 'Start a voice call with the group'}
            disabled={Boolean(call) || problems.length > 0}
            onClick={() => startGroupCall(groupId)}
          >
            <FontAwesomeIcon icon={faPhone} />
          </button>
        )}
        <button
          type="button"
          className={`chat-call-button group-members-button${showMembers ? ' active' : ''}`}
          aria-label={showMembers ? 'Hide members' : 'Show members'}
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
            {problems.map((p) => nameOf(p.user)).join(', ')}
            {problems.length === 1 ? ' has' : ' have'} a different security key than when added to this group.
            Until that&apos;s sorted out, nothing can be sent here.
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
              Accept the new key{changed.length > 1 ? 's' : ''}
            </button>
          ) : (
            <p className="vc-hint">They have to be removed and added again.</p>
          )}
        </div>
      )}

      <div className="group-dm-body">
        <div className="group-dm-chat">
          <ChatPane
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
            cantSendText={group ? "Can't send until the security keys are sorted out." : 'Loading…'}
            emptyText="No messages yet. Say hi to the group!"
          />
        </div>
        {showMembers && group && (
          <GroupMembers group={group} user={user} users={users} onClose={isMobile ? () => setShowMembers(false) : undefined} />
        )}
      </div>
    </div>
  );
}
