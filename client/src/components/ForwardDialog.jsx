import React, { useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { faNoteSticky } from '@fortawesome/free-solid-svg-icons';
import '../assets/css/groups.css';
import Modal from './guild/Modal';
import Avatar from './Avatar';
import { Icon } from './Icon';
import GroupPicture from './group/GroupPicture';
import ChannelIcon from './guild/ChannelIcon';
import { ChannelMentionContext } from '../contexts';
import { matchesDestination, useChatDestinations } from '../hooks/useChatDestinations';
import { forwardPreview } from '../utils/forwardPreview';
import { showContent } from '../utils/mobilePanes';
import { setForward } from '../services/forwardStore';
import { t } from '../i18n';

// Forward a message (as Discord's): pick where it goes (your notes, a DM, a group DM or a guild
// text channel you may write in), which opens that chat with the message waiting in its
// message box ("Forwarding a message", forwardStore), to add a message of your own and send.
// `source` is utils/forwardMarkup.js forwardSource's { content, at }; `encrypted`: it comes
// from a DM, group DM or notes, so a guild channel shows that the forward won't be encrypted
// there (the server could read it, files included: their keys go with it).
export default function ForwardDialog({ user, source, encrypted = false, onClose }) {
  const navigate = useNavigate();
  const { channels: mentionChannels } = useContext(ChannelMentionContext) ?? {};
  const destinations = useChatDestinations(user);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const shown = destinations.filter((d) => matchesDestination(d, q));

  function forwardTo(destination) {
    setForward(destination.chatId, source);
    onClose();
    navigate(destination.path);
    showContent();
  }

  const preview = forwardPreview(source.content, mentionChannels);

  return (
    <Modal title={t('chat.forward.title')} className="group-dialog forward-dialog" onClose={onClose}>
      <blockquote className="forward-dialog-preview">{preview.slice(0, 300)}</blockquote>
      <input
        type="search"
        className="form-control"
        placeholder={t('chat.forward.search')}
        aria-label={t('chat.forward.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <ul className="user-picker-list forward-dialog-list">
        {shown.map((d) => (
          <li key={d.key}>
            <button type="button" className="user-picker-row forward-dialog-row" onClick={() => forwardTo(d)}>
              {d.kind === 'notes' && <span className="forward-dialog-icon"><Icon icon={faNoteSticky} /></span>}
              {d.kind === 'dm' && <Avatar userId={d.person.id} alt="" className="user-picker-avatar" />}
              {d.kind === 'group' && (
                <GroupPicture groupId={d.group.id} picture={d.group.picture} className="user-picker-avatar group-picture">
                  <span className="forward-dialog-icon">{d.group.members.length}</span>
                </GroupPicture>
              )}
              {d.kind === 'channel' && <span className="forward-dialog-icon"><ChannelIcon channel={d.channel} /></span>}
              <span className="user-picker-name">
                {d.name}
                {d.guildName && <span className="forward-dialog-guild">{d.guildName}</span>}
              </span>
              {d.kind === 'channel' && encrypted && (
                <span className="forward-dialog-note" title={t('chat.forward.notEncryptedTitle')}>{t('chat.forward.notEncrypted')}</span>
              )}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="user-picker-empty">{t('chat.forward.empty')}</li>}
      </ul>
    </Modal>
  );
}
