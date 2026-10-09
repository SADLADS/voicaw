import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronRight, faCopy, faPlus } from '@fortawesome/free-solid-svg-icons';
import { createWebhook, deleteWebhook, fetchChannelWebhooks, updateWebhook } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { webhookUrl } from '../../utils/webhookUrl';
import { MAX_PICTURE_BYTES, croppedPictureData, croppedPreview } from '../../utils/pictureData';
import { useDateFormat, formatDate } from '../../utils/dateFormat';
import ImageCropper from '../ImageCropper';
import defaultAvatar from '../../assets/images/default.png';
import { t } from '../../i18n';

// The server shrinks the picture (like a profile picture), so the original can be big.
const MAX_AVATAR_BYTES = MAX_PICTURE_BYTES;
const NAME_LENGTH = 80;

// One webhook: its picture (cropped like a profile picture) and name, opened to change them,
// copy its URL or delete it.
function WebhookRow({ hook, open, onToggle, onChanged, onDeleted }) {
  const [name, setName] = useState(hook.name);
  // A picture picked and cropped but not saved ({ data, crop, preview }: croppedPictureData's
  // data URI and crop, and a blob URL showing the crop), or null to remove it.
  const [avatar, setAvatar] = useState(undefined);
  const [cropping, setCropping] = useState(null); // a picked file, in the cropper
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => setName(hook.name), [hook.name]);
  const preview = avatar?.preview;
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const dirty = name.trim() !== hook.name || avatar !== undefined;
  const picture = avatar === undefined ? hook.avatar_url ?? defaultAvatar : avatar?.preview ?? defaultAvatar;

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

  function pick(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError(t('guildAdmin.webhooks.pickImage'));
    if (file.size > MAX_AVATAR_BYTES) return setError(t('guildAdmin.webhooks.tooBig'));
    setError(null);
    setCropping(file);
  }

  async function applyCrop(crop) {
    const file = cropping;
    setCropping(null);
    try {
      const { data, crop: left } = await croppedPictureData(file, crop);
      let url;
      try {
        url = await croppedPreview(file, crop);
      } catch {
        url = URL.createObjectURL(file); // can't draw it here: the whole picture stands in
      }
      setAvatar({ data, crop: left, preview: url });
    } catch {
      setError(t('guildAdmin.webhooks.unreadable'));
    }
  }

  const save = () => run(async () => {
    const changes = {};
    if (name.trim() !== hook.name) changes.name = name.trim();
    if (avatar === null) changes.avatar = null;
    else if (avatar) {
      changes.avatar = avatar.data;
      if (avatar.crop) changes.avatarCrop = avatar.crop; // a GIF, cut by the server to stay animated
    }
    onChanged(await updateWebhook(hook.id, changes));
    setAvatar(undefined);
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(webhookUrl(hook));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t('guildAdmin.webhooks.copyFailed'));
    }
  }

  return (
    <li className={`webhook-row${open ? ' open' : ''}`}>
      <button type="button" className="webhook-summary" aria-expanded={open} onClick={onToggle}>
        <img className="webhook-avatar" src={hook.avatar_url ?? defaultAvatar} alt="" />
        <span className="webhook-summary-text">
          <span className="webhook-name">{hook.name}</span>
          <span className="vc-hint">
            {hook.user
              ? t('guildAdmin.webhooks.createdBy', { date: formatDate(hook.created_at * 1000), name: hook.user.username })
              : t('guildAdmin.webhooks.created', { date: formatDate(hook.created_at * 1000) })}
          </span>
        </span>
        <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} className="webhook-chevron" />
      </button>
      {open && (
        <div className="webhook-editor">
          <div className="webhook-editor-top">
            <button type="button" className="webhook-avatar-picker" title={t('guildAdmin.webhooks.changePicture')} onClick={() => fileRef.current?.click()}>
              <img className="webhook-avatar large" src={picture} alt={t('guildAdmin.webhooks.pictureOf', { name: hook.name })} />
              <span>{t('guildAdmin.webhooks.change')}</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              aria-label={t('guildAdmin.webhooks.picture')}
              onChange={(e) => { pick(e.target.files[0]); e.target.value = ''; }}
            />
            <label className="webhook-name-field">
              <span className="vc-label">{t('guildAdmin.webhooks.name')}</span>
              <input
                className="form-control form-control-sm"
                value={name}
                maxLength={NAME_LENGTH}
                aria-label={t('guildAdmin.webhooks.nameLabel')}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && dirty && name.trim()) save(); }}
              />
            </label>
          </div>
          {(hook.avatar_url || avatar) && (
            <button type="button" className="btn btn-link btn-sm webhook-remove-avatar" onClick={() => setAvatar(avatar ? undefined : null)}>
              {avatar ? t('guildAdmin.webhooks.undoPicture') : t('guildAdmin.webhooks.removePicture')}
            </button>
          )}
          {error && <p className="error-msg" role="alert">{error}</p>}
          <div className="webhook-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
              <FontAwesomeIcon icon={faCopy} /> {copied ? t('guildAdmin.webhooks.copied') : t('guildAdmin.webhooks.copyUrl')}
            </button>
            {confirmingDelete ? (
              <>
                <span className="vc-hint">{t('guildAdmin.webhooks.confirmDelete', { name: hook.name })}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDelete(false)}>{t('common.cancel')}</button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => run(async () => { await deleteWebhook(hook.id); onDeleted(hook.id); })}
                >
                  {t('common.delete')}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => setConfirmingDelete(true)}>{t('guildAdmin.webhooks.delete')}</button>
            )}
            {dirty && !confirmingDelete && (
              <button type="button" className="btn btn-primary btn-sm vc-button" disabled={busy || !name.trim()} onClick={save}>{t('guildAdmin.webhooks.saveChanges')}</button>
            )}
          </div>
        </div>
      )}
      {cropping && <ImageCropper file={cropping} onApply={applyCrop} onCancel={() => setCropping(null)} />}
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
      const hook = await createWebhook(channel.id, { name: t('guildAdmin.webhooks.defaultName') });
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
      <p className="vc-hint">{t('guildAdmin.webhooks.intro', { name: channel.name })}</p>
      <div className="vc-form-row">
        <button type="button" className="btn btn-primary btn-sm vc-button" disabled={busy} onClick={create}>
          <FontAwesomeIcon icon={faPlus} /> {t('guildAdmin.webhooks.new')}
        </button>
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {hooks == null ? (!error && <p className="vc-hint">{t('common.loading')}</p>) : hooks.length === 0 ? (
        <p className="vc-hint">{t('guildAdmin.webhooks.none')}</p>
      ) : (
        <ul className="webhook-list" aria-label={t('guildAdmin.channelDialog.tabs.webhooks')}>
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
