import React, { useContext, useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft, faBoxArchive, faBoxOpen, faComments, faEdit, faEllipsis, faLink, faRightFromBracket, faTrash, faUserPlus, faXmark,
} from '@fortawesome/free-solid-svg-icons';
import ChatPane from '../ChatPane';
import ContextMenu from '../ContextMenu';
import ConfirmDialog from './ConfirmDialog';
import ThreadDialog from './ThreadDialog';
import { MessageContent } from '../MessageList';
import Avatar from '../Avatar';
import { ConfigContext, ThreadContext } from '../../contexts';
import { useChannel } from '../../hooks/useChannel';
import { onGuildEvent } from '../../utils/ws-client';
import { deleteThread, fetchThread, setThreadJoined, updateThread } from '../../services/guildService';
import { channelLink, errorMessage } from '../../utils/guildDisplay';
import { PERMISSIONS, has, threadPermissions } from '../../utils/permissions';
import { displayName, useProfiles } from '../../utils/profiles';
import { formatDateTime, useDateFormat } from '../../utils/dateFormat';

// A thread beside its text channel (`parent`), like Discord's: its name, a menu (join or leave,
// rename and archive for its starter or Manage Messages, delete for Manage Messages, copy
// link), the message it started from, and its chat (ChatPane over useChannel, as the side
// chat). On a phone it covers the channel, with a way back. `chatProps` are what GuildView
// gives a channel's ChatPane (names, mentions, reactions). `onClose` closes it (also when it's
// deleted).
export default function ThreadPane({ guild, parent, threadId, user, isMobile, chatProps, onClose }) {
  useProfiles();
  useDateFormat();
  const { s3Endpoint } = useContext(ConfigContext);
  const [thread, setThread] = useState(null);
  const [starter, setStarter] = useState(null);
  const [error, setError] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [dialog, setDialog] = useState(null); // 'rename' | 'delete'
  const conversation = useChannel({ channelId: thread ? String(thread.id) : null, side: true, user, onRead: chatProps.onRead });

  useEffect(() => {
    let cancelled = false;
    setThread(null);
    setStarter(null);
    setError(null);
    fetchThread(threadId)
      .then((data) => {
        if (cancelled) return;
        setThread(data.thread);
        setStarter(data.starter);
      })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    const id = Number(threadId);
    const off = onGuildEvent((event) => {
      if (event.type === 'guild_thread_update' && event.thread.id === id) {
        setThread((old) => (old ? { ...event.thread, joined: old.joined } : old));
      } else if (event.type === 'guild_thread_member' && event.threadId === id) {
        setThread((old) => (old ? { ...old, joined: event.joined } : old));
      } else if (event.type === 'guild_thread_delete' && event.threadId === id) {
        onClose();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const permissions = threadPermissions(parent.my_permissions);
  const canManage = has(permissions, PERMISSIONS.MANAGE_MESSAGES);
  const own = thread?.owner_id === user.id;
  const canSend = has(permissions, PERMISSIONS.SEND_MESSAGES);

  async function act(action) {
    try {
      setError(null);
      const saved = await action();
      if (saved?.id) setThread((old) => ({ ...old, ...saved }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const menuItems = thread ? [
    thread.joined
      ? { key: 'leave', label: 'Leave Thread', icon: faRightFromBracket, hint: 'It leaves your channel list', onSelect: () => setThreadJoined(thread.id, false) }
      : { key: 'join', label: 'Join Thread', icon: faUserPlus, hint: 'Keep it in your channel list', onSelect: () => setThreadJoined(thread.id, true) },
    ...(own || canManage ? [{ key: 'rename', label: 'Rename Thread', icon: faEdit, onSelect: () => setDialog('rename') }] : []),
    ...(thread.archived
      ? (canSend || canManage ? [{ key: 'unarchive', label: 'Unarchive Thread', icon: faBoxOpen, onSelect: () => act(() => updateThread(thread.id, { archived: false })) }] : [])
      : (own || canManage ? [{ key: 'archive', label: 'Archive Thread', icon: faBoxArchive, onSelect: () => act(() => updateThread(thread.id, { archived: true })) }] : [])),
    {
      key: 'copy-link',
      label: 'Copy Link',
      icon: faLink,
      onSelect: async () => {
        await navigator.clipboard.writeText(`${channelLink(guild.id, parent.id)}?thread=${thread.id}`);
        return 'Link copied';
      },
    },
    ...(canManage ? [{ separator: true }, { key: 'delete', label: 'Delete Thread', icon: faTrash, danger: true, onSelect: () => setDialog('delete') }] : []),
  ] : [];

  return (
    <aside className={`thread-pane${isMobile ? ' mobile' : ''}`} aria-label="Thread">
      <header className="thread-pane-header">
        {isMobile && (
          <button type="button" className="icon-button" aria-label={`Back to #${parent.name}`} onClick={onClose}>
            <FontAwesomeIcon icon={faArrowLeft} />
          </button>
        )}
        <FontAwesomeIcon icon={faComments} className="thread-pane-icon" />
        <div className="thread-pane-title">
          <h5>{thread?.name ?? ''}</h5>
          <small>#{parent.name}{thread?.archived ? ' · Archived' : ''}</small>
        </div>
        {thread && !thread.joined && (
          <button type="button" className="btn btn-sm btn-secondary thread-pane-join" onClick={() => act(() => setThreadJoined(thread.id, true))}>
            Join
          </button>
        )}
        {thread && (
          <button
            type="button"
            className={`icon-button thread-pane-menu-button${menuAnchor ? ' active' : ''}`}
            aria-label="Thread options"
            aria-haspopup="menu"
            onClick={(e) => setMenuAnchor(e.currentTarget.getBoundingClientRect())}
          >
            <FontAwesomeIcon icon={faEllipsis} />
          </button>
        )}
        {!isMobile && (
          <button type="button" className="icon-button" aria-label="Close thread" title="Close" onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        )}
      </header>

      {error && <p className="error-text thread-pane-error">{error}</p>}

      {starter && (
        <div className="thread-starter">
          <div className="thread-starter-header">
            <Avatar userId={starter.sender_id} alt={displayName(starter.sender_id, starter.sender_username)} className="thread-starter-avatar" />
            <strong style={{ color: chatProps.nameColors?.[starter.sender_id] }}>{displayName(starter.sender_id, starter.sender_username)}</strong>
            <small>{formatDateTime(starter.timestamp * 1000)}</small>
          </div>
          <MessageContent
            msg={{ ...starter, plaintext: starter.content }}
            user={user}
            s3Endpoint={s3Endpoint}
            reactionNames={chatProps.reactionNames}
            mentionRoles={chatProps.mentionRoles}
            myRoleIds={chatProps.myRoleIds}
          />
        </div>
      )}
      {thread?.archived && (
        <p className="thread-pane-archived" role="status">
          This thread is archived.{canSend ? ' Sending a message brings it back.' : ''}
        </p>
      )}

      <div className="thread-pane-chat">
        {/* No threads inside threads. */}
        <ThreadContext.Provider value={null}>
          {thread && (
            <ChatPane
              {...chatProps}
              chatId={`channel-${thread.id}`}
              chatName={thread.name}
              conversation={conversation}
              canModerate={canManage}
              canSend={canSend}
              cantSendText="You do not have permission to send messages in this thread."
              canPin={has(permissions, PERMISSIONS.PIN_MESSAGES)}
              emptyText="No messages in this thread yet. Say something!"
            />
          )}
        </ThreadContext.Provider>
      </div>

      {menuAnchor && (
        <ContextMenu
          label="Thread options"
          title={thread?.name}
          sheet={isMobile}
          items={menuItems}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
        />
      )}
      {dialog === 'rename' && thread && (
        <ThreadDialog channel={parent} thread={thread} onDone={(saved) => setThread((old) => ({ ...old, ...saved }))} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && thread && (
        <ConfirmDialog
          title="Delete thread"
          message={`Delete "${thread.name}" and all its messages? This can't be undone.`}
          confirmLabel="Delete thread"
          onConfirm={async () => {
            await deleteThread(thread.id);
            onClose();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </aside>
  );
}
