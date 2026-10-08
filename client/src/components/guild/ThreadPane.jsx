import React, { useContext, useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft, faBoxArchive, faBoxOpen, faComments, faDownLeftAndUpRightToCenter, faEdit, faEllipsis, faLink,
  faRightFromBracket, faTrash, faUpRightAndDownLeftFromCenter, faUserPlus, faXmark,
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
import { copyIdItem } from '../../utils/copyId';
import { t } from '../../i18n';

// A thread beside its text channel (`parent`), like Discord's: its name, a menu (join or leave,
// rename and archive for its starter or Manage Messages, delete for Manage Messages, copy
// link), and its chat (ChatPane over useChannel, as the side chat), which starts, above its
// first message, with the thread's name, who started it and the message it started from
// (ThreadStart). On a phone it covers the channel, with a way back. On a computer, `full` gives
// it the whole page (Discord's full view), `onSetFull(full)` switches. `chatProps` are what
// GuildView gives a channel's ChatPane (names, mentions, reactions). `onClose` closes it (also
// when it's deleted).
export default function ThreadPane({ guild, parent, threadId, user, isMobile, chatProps, full = false, onSetFull, onClose }) {
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
      ? { key: 'leave', label: t('guilds.threads.pane.leave'), icon: faRightFromBracket, hint: t('guilds.threads.pane.leaveHint'), onSelect: () => setThreadJoined(thread.id, false) }
      : { key: 'join', label: t('guilds.threads.pane.joinThread'), icon: faUserPlus, hint: t('guilds.threads.pane.joinHint'), onSelect: () => setThreadJoined(thread.id, true) },
    ...(own || canManage ? [{ key: 'rename', label: t('guilds.threads.pane.rename'), icon: faEdit, onSelect: () => setDialog('rename') }] : []),
    ...(thread.archived
      ? (canSend || canManage ? [{ key: 'unarchive', label: t('guilds.threads.pane.unarchive'), icon: faBoxOpen, onSelect: () => act(() => updateThread(thread.id, { archived: false })) }] : [])
      : (own || canManage ? [{ key: 'archive', label: t('guilds.threads.pane.archive'), icon: faBoxArchive, onSelect: () => act(() => updateThread(thread.id, { archived: true })) }] : [])),
    {
      key: 'copy-link',
      label: t('guilds.threads.pane.copyLink'),
      icon: faLink,
      onSelect: async () => {
        await navigator.clipboard.writeText(`${channelLink(guild.id, parent.id)}?thread=${thread.id}`);
      },
    },
    copyIdItem('thread', thread.id),
    ...(canManage ? [{ separator: true }, { key: 'delete', label: t('guilds.threads.pane.deleteThread'), icon: faTrash, danger: true, onSelect: () => setDialog('delete') }] : []),
  ] : [];

  const head = thread && (
    <ThreadStart
      thread={thread}
      starter={starter}
      empty={!conversation.isLoading && conversation.messages.length === 0}
      user={user}
      s3Endpoint={s3Endpoint}
      chatProps={chatProps}
    />
  );

  return (
    <aside className={`thread-pane${isMobile ? ' mobile' : ''}${full ? ' full' : ''}`} aria-label={t('guilds.threads.pane.label')}>
      <header className="thread-pane-header">
        {isMobile && (
          <button type="button" className="icon-button" aria-label={t('guilds.threads.pane.back', { name: parent.name })} onClick={onClose}>
            <FontAwesomeIcon icon={faArrowLeft} />
          </button>
        )}
        <FontAwesomeIcon icon={faComments} className="thread-pane-icon" />
        <div className="thread-pane-title">
          <h5>{thread?.name ?? ''}</h5>
          {full ? (
            // Full view: back to the channel.
            <button type="button" className="thread-pane-parent" title={t('guilds.threads.pane.back', { name: parent.name })} onClick={onClose}>
              {thread?.archived ? t('guilds.threads.pane.channelArchived', { name: parent.name }) : t('guilds.threads.pane.channel', { name: parent.name })}
            </button>
          ) : (
            <small>{thread?.archived ? t('guilds.threads.pane.channelArchived', { name: parent.name }) : t('guilds.threads.pane.channel', { name: parent.name })}</small>
          )}
        </div>
        {thread && !thread.joined && (
          <button type="button" className="btn btn-sm btn-secondary thread-pane-join" onClick={() => act(() => setThreadJoined(thread.id, true))}>
            {t('guilds.threads.pane.join')}
          </button>
        )}
        {thread && (
          <button
            type="button"
            className={`icon-button thread-pane-menu-button${menuAnchor ? ' active' : ''}`}
            aria-label={t('guilds.threads.pane.options')}
            aria-haspopup="menu"
            onClick={(e) => setMenuAnchor(e.currentTarget.getBoundingClientRect())}
          >
            <FontAwesomeIcon icon={faEllipsis} />
          </button>
        )}
        {!isMobile && onSetFull && (
          <button
            type="button"
            className="icon-button"
            aria-label={full ? t('guilds.threads.pane.sideView') : t('guilds.threads.pane.fullView')}
            title={full ? t('guilds.threads.pane.sideView') : t('guilds.threads.pane.fullView')}
            onClick={() => onSetFull(!full)}
          >
            <FontAwesomeIcon icon={full ? faDownLeftAndUpRightToCenter : faUpRightAndDownLeftFromCenter} />
          </button>
        )}
        {!isMobile && (
          <button type="button" className="icon-button" aria-label={t('guilds.threads.pane.close')} title={t('common.close')} onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        )}
      </header>

      {error && <p className="error-text thread-pane-error">{error}</p>}

      {thread?.archived && (
        <p className="thread-pane-archived" role="status">
          {canSend ? t('guilds.threads.pane.archivedCanSend') : t('guilds.threads.pane.archived')}
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
              cantSendText={t('guilds.threads.pane.cantSend')}
              canPin={has(permissions, PERMISSIONS.PIN_MESSAGES)}
              emptyText={t('guilds.threads.pane.empty')}
              listHead={head}
            />
          )}
        </ThreadContext.Provider>
      </div>

      {menuAnchor && (
        <ContextMenu
          label={t('guilds.threads.pane.options')}
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
          title={t('guilds.threads.pane.deleteTitle')}
          message={t('guilds.threads.pane.deleteMessage', { name: thread.name })}
          confirmLabel={t('guilds.threads.pane.deleteTitle')}
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

// The top of a thread's chat, as in Discord: its icon and name, who started it, then the message
// it started from, drawn like a message of the thread's (it's the channel's: no menu here), and
// `empty` adds that nothing's been said yet.
function ThreadStart({ thread, starter, empty, user, s3Endpoint, chatProps }) {
  const owner = displayName(thread.owner_id, '');
  return (
    <div className="thread-start">
      <div className="thread-start-icon" aria-hidden="true"><FontAwesomeIcon icon={faComments} /></div>
      <h3 className="thread-start-name">{thread.name}</h3>
      {owner && (
        <p className="thread-start-by">
          {t('guilds.threads.pane.startedBy')}{' '}
          <strong style={{ color: chatProps.nameColors?.[thread.owner_id] }}>{owner}</strong>
        </p>
      )}
      {starter && (
        <div className="each-dm-message-wrapper received thread-start-message">
          <div className="dm-message message received">
            <Avatar userId={starter.sender_id} alt={displayName(starter.sender_id, starter.sender_username)} className="message-avatar" />
            <strong className="message-author" style={{ color: chatProps.nameColors?.[starter.sender_id] }}>
              {displayName(starter.sender_id, starter.sender_username)}
            </strong>{' '}
            <small>
              <span title={formatDateTime(starter.timestamp * 1000, { seconds: true })}>{formatDateTime(starter.timestamp * 1000)}</span>
            </small>
            <MessageContent
              msg={{ ...starter, plaintext: starter.content }}
              user={user}
              s3Endpoint={s3Endpoint}
              reactionNames={chatProps.reactionNames}
              mentionRoles={chatProps.mentionRoles}
              myRoleIds={chatProps.myRoleIds}
            />
          </div>
        </div>
      )}
      {empty && <p className="chat-empty thread-start-empty">{t('guilds.threads.pane.empty')}</p>}
    </div>
  );
}
