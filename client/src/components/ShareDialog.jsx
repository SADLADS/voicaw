import React, { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { faFile, faNoteSticky } from '@fortawesome/free-solid-svg-icons';
import '../assets/css/groups.css';
import Modal from './guild/Modal';
import Avatar from './Avatar';
import { Icon } from './Icon';
import GroupPicture from './group/GroupPicture';
import ChannelIcon from './guild/ChannelIcon';
import { ConfigContext } from '../contexts';
import { matchesDestination, useChatDestinations } from '../hooks/useChatDestinations';
import { orderByRecent } from '../utils/chatDestinations';
import { sharedFileSrc, showAndroidToast } from '../utils/android';
import { showContent } from '../utils/mobilePanes';
import { formatBytes } from '../utils/formatBytes';
import { DEFAULT_MAX_UPLOAD_BYTES, maxAttachmentBytes } from '../services/attachmentUpload';
import { clearShare, fetchRecentChats, getShare, onShareChange, shareText, uploadSharedFiles } from '../services/shareService';
import { sendToChat } from '../services/chatSend';
import { t } from '../i18n';

// Whatever another app shared to the Android app, while one waits (services/shareService.js).
export function ShareHost({ user }) {
  const share = useSyncExternalStore(onShareChange, getShare);
  if (!share || !user?.id) return null;
  // A new share starts afresh.
  return <ShareDialog key={shareKey(share)} user={user} share={share} onClose={clearShare} />;
}

let shares = 0;
const shareKeys = new WeakMap();
function shareKey(share) {
  if (!shareKeys.has(share)) shareKeys.set(share, ++shares);
  return shareKeys.get(share);
}

// The share screen (as Discord's): what was shared, a message to go with it, and the chats to
// send it to, several at once, the ones you last sent to first (GET /recent-chats), with a search
// box. Send uploads the files once (encrypted, as any attachment) and sends the same message to
// each chat picked, from here (services/chatSend.js), without opening them; one that fails stays
// picked, with why, to try again (the files aren't uploaded again).
export default function ShareDialog({ user, share, onClose }) {
  const navigate = useNavigate();
  const config = useContext(ConfigContext) ?? {};
  const limit = config.maxUploadBytes || DEFAULT_MAX_UPLOAD_BYTES;
  const maxBytes = maxAttachmentBytes(limit);
  const maxLength = config.maxPlaintextLength ?? 4000;
  const destinations = useChatDestinations(user);
  const [recents, setRecents] = useState(null);
  const [caption, setCaption] = useState(share.text ?? '');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]); // keys, in the order picked
  const [sentTo, setSentTo] = useState([]); // keys already sent to (a retry skips them)
  const [status, setStatus] = useState(null); // { percent } while uploading, 'sending'
  const [errors, setErrors] = useState([]);
  const uploaded = useRef(null); // the files' markup, once uploaded
  const nonces = useRef(new Map()); // key -> the nonce its message is sent with, every try

  useEffect(() => {
    let stale = false;
    fetchRecentChats().then((rows) => { if (!stale) setRecents(rows); }).catch(() => { if (!stale) setRecents([]); });
    return () => { stale = true; };
  }, []);

  const ordered = useMemo(() => orderByRecent(destinations, recents, user.id), [destinations, recents, user.id]);
  const q = query.trim().toLowerCase();
  const shown = ordered.filter((d) => matchesDestination(d, q));
  const files = share.files ?? [];
  const tooBig = files.filter((f) => f.size > maxBytes);
  const busy = status !== null;
  const waiting = picked.filter((key) => !sentTo.includes(key));

  function toggle(key) {
    setPicked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function send() {
    setErrors([]);
    if (uploaded.current === null) {
      setStatus({ percent: 0 });
      try {
        uploaded.current = files.length
          ? await uploadSharedFiles(files, { maxBytes, onProgress: (percent) => setStatus({ percent }) })
          : '';
      } catch (err) {
        setStatus(null);
        setErrors([err.tooBig ? tooBigMessage(err.tooBig, limit) : err.message]);
        return;
      }
    }
    const text = shareText(caption, uploaded.current);
    if (!text) {
      setStatus(null);
      return;
    }
    if (text.length > maxLength) {
      setStatus(null);
      setErrors([t('chat.composer.tooLongWithLinks', { count: text.length - maxLength })]);
      return;
    }

    setStatus('sending');
    const targets = waiting.map((key) => destinations.find((d) => d.key === key)).filter(Boolean);
    const results = await Promise.allSettled(targets.map((d) => {
      if (!nonces.current.has(d.key)) nonces.current.set(d.key, crypto.randomUUID());
      return sendToChat(user, d, text, { nonce: nonces.current.get(d.key) });
    }));
    const done = targets.filter((d, i) => results[i].status === 'fulfilled').map((d) => d.key);
    const failures = targets
      .map((d, i) => (results[i].status === 'rejected' ? t('chat.share.failed', { name: d.name, error: errorText(results[i].reason) }) : null))
      .filter(Boolean);
    const allSent = [...sentTo, ...done];
    setSentTo(allSent);
    setStatus(null);
    if (failures.length) {
      setErrors(failures);
      return;
    }

    showAndroidToast(t('chat.share.sent', { count: allSent.length }));
    onClose();
    // Just one: that's where you're going.
    const only = allSent.length === 1 ? destinations.find((d) => d.key === allSent[0]) : null;
    if (only) {
      navigate(only.path);
      showContent();
    }
  }

  const sendLabel = status === 'sending'
    ? t('chat.share.sending')
    : status ? t('chat.share.uploading', { percent: status.percent })
      : waiting.length ? t('chat.share.sendTo', { count: waiting.length }) : t('chat.share.send');

  return (
    <Modal
      title={t('chat.share.title')}
      className="group-dialog share-dialog"
      onClose={busy ? () => {} : onClose}
      actions={(
        <button
          type="button"
          className="btn btn-primary btn-sm vc-button"
          onClick={send}
          disabled={busy || waiting.length === 0 || tooBig.length > 0 || (!files.length && !caption.trim())}
        >
          {sendLabel}
        </button>
      )}
    >
      {files.length > 0 && (
        <div className="share-dialog-files" aria-label={t('chat.share.files', { count: files.length })}>
          {files.map((file) => (
            <div key={file.uri} className="share-dialog-file" title={file.name}>
              {file.type?.startsWith('image/')
                ? <img src={sharedFileSrc(file)} alt={file.name} />
                : (
                  <>
                    <Icon icon={faFile} className="share-dialog-file-icon" />
                    <span className="share-dialog-file-name">{file.name}</span>
                  </>
                )}
            </div>
          ))}
        </div>
      )}
      {share.skipped > 0 && <p className="share-dialog-note">{t('chat.share.skipped', { count: share.skipped })}</p>}
      {tooBig.length > 0 && <p className="share-dialog-error" role="alert">{tooBigMessage(tooBig.map((f) => f.name), limit)}</p>}
      <textarea
        className="form-control share-dialog-caption"
        placeholder={t('chat.share.caption')}
        aria-label={t('chat.share.caption')}
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        rows={2}
        disabled={busy}
      />
      <input
        type="search"
        className="form-control share-dialog-search"
        placeholder={t('chat.share.search')}
        aria-label={t('chat.share.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {errors.map((error) => <p key={error} className="share-dialog-error" role="alert">{error}</p>)}
      <ul className="user-picker-list share-dialog-list">
        {shown.map((d) => {
          const sent = sentTo.includes(d.key);
          return (
            <li key={d.key}>
              <label className={`user-picker-row forward-dialog-row${picked.includes(d.key) ? ' selected' : ''}`}>
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
                {d.kind === 'channel' && (
                  <span className="forward-dialog-note" title={t('chat.share.notEncryptedTitle')}>{t('chat.share.notEncrypted')}</span>
                )}
                <input
                  type="checkbox"
                  checked={sent || picked.includes(d.key)}
                  disabled={busy || sent}
                  onChange={() => toggle(d.key)}
                />
              </label>
            </li>
          );
        })}
        {shown.length === 0 && <li className="user-picker-empty">{t('chat.share.empty')}</li>}
      </ul>
    </Modal>
  );
}

function tooBigMessage(names, limit) {
  return t('media.drafts.tooBig', { count: names.length, names: names.join(', '), limit: formatBytes(limit) });
}

// The server's reason when it gave one (blocked, no permission...), else what went wrong here.
function errorText(err) {
  return err?.response?.data?.error || err?.message || String(err);
}
