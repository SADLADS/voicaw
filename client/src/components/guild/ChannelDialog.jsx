import React, { useState } from 'react';
import { Icon } from '../Icon';
import { faFileLines, faHashtag, faListCheck, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import Modal from './Modal';
import ChannelPermissions from './ChannelPermissions';
import ChannelWebhooks from './ChannelWebhooks';
import VoiceChannelSettings from './VoiceChannelSettings';
import { createChannel, deleteChannel, updateChannel } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { PERMISSIONS, colorToHex, has, memberRank } from '../../utils/permissions';
import { t } from '../../i18n';

// Creating a channel (no `channel`; in `categoryId` if given), optionally private to some
// roles, or editing one: Overview (name, topic, category, NSFW, a voice channel's bitrate, user
// limit and region (VoiceChannelSettings), delete), with Manage Roles
// Permissions (ChannelPermissions) and, for a text channel with Manage Webhooks, Webhooks
// (ChannelWebhooks). The server checks every permission again.
export default function ChannelDialog({ guild, channel, user, categoryId = null, onCreated, onClose }) {
  const editing = Boolean(channel);
  const managesRoles = has(guild.my_permissions, PERMISSIONS.MANAGE_ROLES);
  const managesWebhooks = editing && ['text', 'voice'].includes(channel.type) && has(channel.my_permissions ?? guild.my_permissions, PERMISSIONS.MANAGE_WEBHOOKS);
  // With only Manage Webhooks, a channel's settings are just its webhooks.
  const managesChannels = has(guild.my_permissions, PERMISSIONS.MANAGE_CHANNELS);
  const tabs = editing ? [
    ...(managesChannels ? [['overview', t('guildAdmin.channelDialog.tabs.overview')]] : []),
    ...(managesRoles ? [['permissions', t('guildAdmin.channelDialog.tabs.permissions')]] : []),
    ...(managesWebhooks ? [['webhooks', t('guildAdmin.channelDialog.tabs.webhooks')]] : []),
  ] : [];
  const [tab, setTab] = useState(tabs[0]?.[0] ?? 'overview');
  const [isPrivate, setIsPrivate] = useState(false);
  const [privateRoleIds, setPrivateRoleIds] = useState([]);
  const myRank = memberRank(guild, user.id, guild.my_role_ids);
  const grantableRoles = (guild.roles ?? []).filter((r) => !r.is_everyone && r.position < myRank);
  const [type, setType] = useState(channel?.type ?? 'text');
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [category, setCategory] = useState(editing ? channel.category_id : categoryId);
  const [nsfw, setNsfw] = useState(Boolean(channel?.nsfw));
  const savedVoice = {
    bitrate: channel?.bitrate ?? 64000, userLimit: channel?.user_limit ?? 0, rtcRegion: channel?.rtc_region ?? null,
  };
  const [voiceSettings, setVoiceSettings] = useState(savedVoice);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function save(e) {
    e.preventDefault();
    if (!name.trim()) return;
    // A voice channel's settings, only those changed.
    const isVoice = (editing ? channel.type : type) === 'voice';
    const voiceChanges = isVoice
      ? Object.fromEntries(Object.entries(voiceSettings).filter(([key, value]) => value !== savedVoice[key]))
      : {};
    run(async () => {
      if (editing) {
        await updateChannel(guild.id, channel.id, {
          name, topic: topic.trim() || null, categoryId: category, ...(nsfw !== Boolean(channel.nsfw) ? { nsfw } : {}), ...voiceChanges,
        });
      } else {
        const created = await createChannel(guild.id, {
          name, type, topic: topic.trim() || null, categoryId: category, ...(nsfw ? { nsfw: true } : {}),
          ...(isPrivate ? { private: true, roleIds: privateRoleIds } : {}), ...voiceChanges,
        });
        onCreated?.(created);
      }
    });
  }

  // Shown as it will be saved: lower case, spaces as dashes.
  const preview = name.trim().toLowerCase().replace(/\s+/g, '-');

  return (
    <Modal
      title={editing ? t('guildAdmin.channelDialog.editTitle', { name: channel.name }) : t('guildAdmin.channelDialog.createTitle')}
      onClose={onClose}
      className={tab !== 'overview' ? 'channel-dialog wide' : 'channel-dialog'}
      actions={tab !== 'overview' ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.done')}</button>
      ) : (
        <>
          {editing && !confirmingDelete && (
            <button type="button" className="btn btn-outline-danger btn-sm me-auto" onClick={() => setConfirmingDelete(true)}>
              {t('guildAdmin.channelDialog.delete')}
            </button>
          )}
          {confirmingDelete ? (
            <>
              <span className="me-auto vc-hint">
                {channel.type === 'list'
                  ? t('guildAdmin.channelDialog.confirmDeleteList', { name: channel.name })
                  : channel.type === 'doc'
                    ? t('guildAdmin.channelDialog.confirmDeleteDoc', { name: channel.name })
                    : t('guildAdmin.channelDialog.confirmDelete', { name: channel.name })}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDelete(false)}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => run(() => deleteChannel(guild.id, channel.id))}>
                {t('common.delete')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
              <button type="submit" form="channel-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !preview}>
                {editing ? t('common.save') : t('guildAdmin.channelDialog.createTitle')}
              </button>
            </>
          )}
        </>
      )}
    >
      {tabs.length > 1 && (
        <div className="settings-tabs" role="tablist">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`settings-tab${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === 'permissions' && <ChannelPermissions guild={guild} channel={channel} user={user} />}
      {tab === 'webhooks' && <ChannelWebhooks channel={channel} />}
      {tab === 'overview' && (
      <form id="channel-form" className="vc-form" onSubmit={save}>
        {!editing && (
          <fieldset className="channel-type-choice">
            <legend>{t('guildAdmin.channelDialog.type.legend')}</legend>
            <label className={type === 'text' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="text" checked={type === 'text'} onChange={() => setType('text')} />
              <Icon icon={faHashtag} /> {t('guildAdmin.channelDialog.type.text')}
            </label>
            <label className={type === 'voice' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="voice" checked={type === 'voice'} onChange={() => setType('voice')} />
              <Icon icon={faVolumeHigh} /> {t('guildAdmin.channelDialog.type.voice')}
            </label>
            <label className={type === 'list' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="list" checked={type === 'list'} onChange={() => setType('list')} />
              <Icon icon={faListCheck} /> {t('guildAdmin.channelDialog.type.list')}
            </label>
            <label className={type === 'doc' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="doc" checked={type === 'doc'} onChange={() => setType('doc')} />
              <Icon icon={faFileLines} /> {t('guildAdmin.channelDialog.type.doc')}
            </label>
          </fieldset>
        )}

        <label htmlFor="channel-name">{t('guildAdmin.channelDialog.name')}</label>
        <input
          id="channel-name"
          className="form-control"
          maxLength={100}
          placeholder={t('guildAdmin.channelDialog.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {preview && preview !== name && <p className="vc-hint">{t('guildAdmin.channelDialog.willBe', { name: preview })}</p>}

        {['text', 'list', 'doc'].includes(editing ? channel.type : type) && (
          <>
            <label htmlFor="channel-topic">{t('guildAdmin.channelDialog.topic')}</label>
            <input
              id="channel-topic"
              className="form-control"
              maxLength={1024}
              placeholder={t('guildAdmin.channelDialog.topicPlaceholder')}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </>
        )}

        <label htmlFor="channel-category">{t('guildAdmin.channelDialog.category')}</label>
        <select
          id="channel-category"
          className="form-select form-control"
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">{t('guildAdmin.channelDialog.noCategory')}</option>
          {guild.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {['text', 'list', 'doc'].includes(editing ? channel.type : type) && (
          <label className="role-toggle nsfw-toggle">
            <input type="checkbox" checked={nsfw} onChange={(e) => setNsfw(e.target.checked)} />
            <span>
              <strong>{t('guildAdmin.channelDialog.nsfw.label')}</strong>
              <span className="vc-hint">{t('guildAdmin.channelDialog.nsfw.hint')}</span>
            </span>
          </label>
        )}

        {(editing ? channel.type : type) === 'voice' && (
          <VoiceChannelSettings value={voiceSettings} onChange={setVoiceSettings} />
        )}

        {!editing && managesRoles && (
          <>
            <label className="role-toggle private-toggle">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
              <span>
                <strong>{t('guildAdmin.channelDialog.private.label')}</strong>
                <span className="vc-hint">
                  {t('guildAdmin.channelDialog.private.hint')}
                  {type === 'list' && ` ${t('guildAdmin.channelDialog.private.listHint')}`}
                  {type === 'doc' && ` ${t('guildAdmin.channelDialog.private.docHint')}`}
                </span>
              </span>
            </label>
            {isPrivate && grantableRoles.length > 0 && (
              <fieldset className="private-roles">
                <legend>{t('guildAdmin.channelDialog.private.whoCanSee')}</legend>
                {grantableRoles.map((role) => (
                  <label key={role.id} className="role-toggle">
                    <input
                      type="checkbox"
                      checked={privateRoleIds.includes(role.id)}
                      onChange={(e) => setPrivateRoleIds((ids) => (e.target.checked ? [...ids, role.id] : ids.filter((id) => id !== role.id)))}
                    />
                    <span className="role-dot" style={{ backgroundColor: role.color != null ? colorToHex(role.color) : undefined }} />
                    <span>{role.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
          </>
        )}
      </form>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
