import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronRight, faCopy, faPlus } from '@fortawesome/free-solid-svg-icons';
import { createWebhook, deleteWebhook, fetchChannelWebhooks, updateWebhook } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { webhookUrl } from '../../utils/webhookUrl';
import { useDateFormat, formatDate } from '../../utils/dateFormat';
import defaultAvatar from '../../assets/images/default.png';

// The server shrinks the picture (like a profile picture), so the original can be big.
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const NAME_LENGTH = 80;

const SHRINK_TO = 512;

const readAsDataUri = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

// The picture as a data: URI (Discord's way of sending one), shrunk to SHRINK_TO px first so
// the request stays small (the server makes it 256×256 anyway). GIFs go as they are, to stay
// animated.
async function pictureData(file) {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return readAsDataUri(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, SHRINK_TO / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.9);
}

// One webhook: its picture and name, opened to change them, copy its URL or delete it.
function WebhookRow({ hook, open, onToggle, onChanged, onDeleted }) {
  const [name, setName] = useState(hook.name);
  const [avatar, setAvatar] = useState(undefined); // a data URI picked but not saved
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => setName(hook.name), [hook.name]);

  const dirty = name.trim() !== hook.name || avatar !== undefined;
  const picture = avatar ?? hook.avatar_url ?? defaultAvatar;

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function pick(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Pick an image.');
    if (file.size > MAX_AVATAR_BYTES) return setError('Pictures can be up to 8 MB.');
    setError(null);
    try {
      setAvatar(await pictureData(file));
    } catch {
      setError("That image couldn't be read.");
    }
  }

  const save = () => run(async () => {
    const changes = {};
    if (name.trim() !== hook.name) changes.name = name.trim();
    if (avatar !== undefined) changes.avatar = avatar;
    onChanged(await updateWebhook(hook.id, changes));
    setAvatar(undefined);
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(webhookUrl(hook));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy it. Your browser may not allow it here.");
    }
  }

  return (
    <li className={`webhook-row${open ? ' open' : ''}`}>
      <button type="button" className="webhook-summary" aria-expanded={open} onClick={onToggle}>
        <img className="webhook-avatar" src={hook.avatar_url ?? defaultAvatar} alt="" />
        <span className="webhook-summary-text">
          <span className="webhook-name">{hook.name}</span>
          <span className="vc-hint">
            Created {formatDate(hook.created_at * 1000)}{hook.user ? ` by ${hook.user.username}` : ''}
          </span>
        </span>
        <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} className="webhook-chevron" />
      </button>
      {open && (
        <div className="webhook-editor">
          <div className="webhook-editor-top">
            <button type="button" className="webhook-avatar-picker" title="Change picture" onClick={() => fileRef.current?.click()}>
              <img className="webhook-avatar large" src={picture} alt={`Picture of ${hook.name}`} />
              <span>Change</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              aria-label="Webhook picture"
              onChange={(e) => { pick(e.target.files[0]); e.target.value = ''; }}
            />
            <label className="webhook-name-field">
              <span className="vc-label">Name</span>
              <input
                className="form-control form-control-sm"
                value={name}
                maxLength={NAME_LENGTH}
                aria-label="Webhook name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && dirty && name.trim()) save(); }}
              />
            </label>
          </div>
          {(hook.avatar_url || avatar) && (
            <button type="button" className="btn btn-link btn-sm webhook-remove-avatar" onClick={() => setAvatar(avatar ? undefined : null)}>
              {avatar ? 'Undo picture change' : 'Remove picture'}
            </button>
          )}
          {error && <p className="error-msg" role="alert">{error}</p>}
          <div className="webhook-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
              <FontAwesomeIcon icon={faCopy} /> {copied ? 'Copied!' : 'Copy Webhook URL'}
            </button>
            {confirmingDelete ? (
              <>
                <span className="vc-hint">Delete {hook.name}? Anything using its URL stops working.</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => run(async () => { await deleteWebhook(hook.id); onDeleted(hook.id); })}
                >
                  Delete
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => setConfirmingDelete(true)}>Delete Webhook</button>
            )}
            {dirty && !confirmingDelete && (
              <button type="button" className="btn btn-primary btn-sm vc-button" disabled={busy || !name.trim()} onClick={save}>Save Changes</button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// A text channel's settings → Webhooks (Manage Webhooks): the channel's webhooks, a button to
// make one (named like Discord's first one), and each one's picture, name, URL and delete.
export default function ChannelWebhooks({ channel }) {
  useDateFormat();
  const [hooks, setHooks] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchChannelWebhooks(channel.id)
      .then((list) => { if (!cancelled) setHooks(list); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [channel.id]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const hook = await createWebhook(channel.id, { name: 'Captain Hook' });
      setHooks((list) => [...(list ?? []), hook]);
      setOpenId(hook.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="channel-webhooks">
      <p className="vc-hint">
        Webhooks let other apps and services post messages into #{channel.name}. Each has its own
        name and picture, and a secret URL: anything that works with Discord webhooks works with it.
        Anyone with the URL can post here, so keep it private.
      </p>
      <div className="vc-form-row">
        <button type="button" className="btn btn-primary btn-sm vc-button" disabled={busy} onClick={create}>
          <FontAwesomeIcon icon={faPlus} /> New Webhook
        </button>
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {hooks == null ? (!error && <p className="vc-hint">Loading…</p>) : hooks.length === 0 ? (
        <p className="vc-hint">No webhooks yet.</p>
      ) : (
        <ul className="webhook-list" aria-label="Webhooks">
          {hooks.map((hook) => (
            <WebhookRow
              key={hook.id}
              hook={hook}
              open={openId === hook.id}
              onToggle={() => setOpenId(openId === hook.id ? null : hook.id)}
              onChanged={(changed) => setHooks((list) => list.map((h) => (h.id === changed.id ? changed : h)))}
              onDeleted={(id) => { setHooks((list) => list.filter((h) => h.id !== id)); setOpenId(null); }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
