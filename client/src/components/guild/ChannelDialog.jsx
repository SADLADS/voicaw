import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHashtag, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import Modal from './Modal';
import ChannelPermissions from './ChannelPermissions';
import ChannelWebhooks from './ChannelWebhooks';
import { createChannel, deleteChannel, updateChannel } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { PERMISSIONS, colorToHex, has, memberRank } from '../../utils/permissions';

// Creating a channel (no `channel`; in `categoryId` if given), optionally private to some
// roles, or editing one: Overview (name, topic, category, delete), with Manage Roles
// Permissions (ChannelPermissions) and, for a text channel with Manage Webhooks, Webhooks
// (ChannelWebhooks). The server checks every permission again.
export default function ChannelDialog({ guild, channel, user, categoryId = null, onCreated, onClose }) {
  const editing = Boolean(channel);
  const managesRoles = has(guild.my_permissions, PERMISSIONS.MANAGE_ROLES);
  const managesWebhooks = editing && channel.type === 'text' && has(channel.my_permissions ?? guild.my_permissions, PERMISSIONS.MANAGE_WEBHOOKS);
  // With only Manage Webhooks, a channel's settings are just its webhooks.
  const managesChannels = has(guild.my_permissions, PERMISSIONS.MANAGE_CHANNELS);
  const tabs = editing ? [
    ...(managesChannels ? [['overview', 'Overview']] : []),
    ...(managesRoles ? [['permissions', 'Permissions']] : []),
    ...(managesWebhooks ? [['webhooks', 'Webhooks']] : []),
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
    run(async () => {
      if (editing) {
        await updateChannel(guild.id, channel.id, { name, topic: topic.trim() || null, categoryId: category });
      } else {
        const created = await createChannel(guild.id, {
          name, type, topic: topic.trim() || null, categoryId: category,
          ...(isPrivate ? { private: true, roleIds: privateRoleIds } : {}),
        });
        onCreated?.(created);
      }
    });
  }

  // Shown as it will be saved: lower case, spaces as dashes.
  const preview = name.trim().toLowerCase().replace(/\s+/g, '-');

  return (
    <Modal
      title={editing ? `Edit #${channel.name}` : 'Create channel'}
      onClose={onClose}
      className={tab !== 'overview' ? 'channel-dialog wide' : 'channel-dialog'}
      actions={tab !== 'overview' ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Done</button>
      ) : (
        <>
          {editing && !confirmingDelete && (
            <button type="button" className="btn btn-outline-danger btn-sm me-auto" onClick={() => setConfirmingDelete(true)}>
              Delete channel
            </button>
          )}
          {confirmingDelete ? (
            <>
              <span className="me-auto vc-hint">Delete #{channel.name} and all its messages?</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDelete(false)}>Cancel</button>
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => run(() => deleteChannel(guild.id, channel.id))}>
                Delete
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
              <button type="submit" form="channel-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !preview}>
                {editing ? 'Save' : 'Create channel'}
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
            <legend>Channel type</legend>
            <label className={type === 'text' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="text" checked={type === 'text'} onChange={() => setType('text')} />
              <FontAwesomeIcon icon={faHashtag} /> Text
            </label>
            <label className={type === 'voice' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="voice" checked={type === 'voice'} onChange={() => setType('voice')} />
              <FontAwesomeIcon icon={faVolumeHigh} /> Voice
            </label>
          </fieldset>
        )}

        <label htmlFor="channel-name">Channel name</label>
        <input
          id="channel-name"
          className="form-control"
          maxLength={100}
          placeholder="new-channel"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {preview && preview !== name && <p className="vc-hint">Will be #{preview}</p>}

        {(editing ? channel.type === 'text' : type === 'text') && (
          <>
            <label htmlFor="channel-topic">Topic</label>
            <input
              id="channel-topic"
              className="form-control"
              maxLength={1024}
              placeholder="Let everyone know how to use this channel"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </>
        )}

        <label htmlFor="channel-category">Category</label>
        <select
          id="channel-category"
          className="form-select form-control"
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">No category</option>
          {guild.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {!editing && managesRoles && (
          <>
            <label className="role-toggle private-toggle">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
              <span>
                <strong>Private channel</strong>
                <span className="vc-hint">Only the roles you pick (and admins) will see it.</span>
              </span>
            </label>
            {isPrivate && grantableRoles.length > 0 && (
              <fieldset className="private-roles">
                <legend>Who can see it</legend>
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
