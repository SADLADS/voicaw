import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faMessage, faXmark } from '@fortawesome/free-solid-svg-icons';
import ChatPane from '../ChatPane';
import { ThreadContext } from '../../contexts';
import { PERMISSIONS, has } from '../../utils/permissions';
import { t } from '../../i18n';

// A voice channel's chat beside it, like Discord's: the channel's own messages (GuildView's
// `conversation`), for anyone who can see the channel, in the call or not. It takes the member
// list's place; on a phone it covers the voice page, with a way back (thread-pane's layout).
// `chatProps` are what GuildView gives a channel's ChatPane; `pins` its pinned list's anchor,
// `jump` a search result to scroll to ({ jumpTo, onJumped }).
export default function VoiceChatPane({ channel, conversation, isMobile, chatProps, pins, jump, onClose }) {
  const permissions = channel.my_permissions ?? 0;
  return (
    <aside className={`thread-pane voice-chat-pane${isMobile ? ' mobile' : ''}`} aria-label={t('guilds.voiceChat.label', { name: channel.name })}>
      <header className="thread-pane-header">
        {isMobile && (
          <button type="button" className="icon-button" aria-label={t('guilds.voiceChat.back', { name: channel.name })} onClick={onClose}>
            <FontAwesomeIcon icon={faArrowLeft} />
          </button>
        )}
        <FontAwesomeIcon icon={faMessage} className="thread-pane-icon" />
        <div className="thread-pane-title">
          <h5>{channel.name}</h5>
          <small>{t('guilds.voiceChat.subtitle')}</small>
        </div>
        {!isMobile && (
          <button type="button" className="icon-button" aria-label={t('guilds.voiceChat.close')} title={t('common.close')} onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        )}
      </header>
      <div className="thread-pane-chat">
        {/* No threads in voice channels, as in Discord. */}
        <ThreadContext.Provider value={null}>
          <ChatPane
            {...chatProps}
            chatId={`channel-${channel.id}`}
            chatName={channel.name}
            conversation={conversation}
            cantSendText={t('guilds.view.cantSend', { name: channel.name })}
            canPin={has(permissions, PERMISSIONS.PIN_MESSAGES)}
            pinsAnchor={pins.anchor}
            onClosePins={pins.onClose}
            jumpTo={jump.jumpTo}
            onJumped={jump.onJumped}
            emptyText={t('guilds.voiceChat.empty', { name: channel.name })}
          />
        </ThreadContext.Provider>
      </div>
    </aside>
  );
}
