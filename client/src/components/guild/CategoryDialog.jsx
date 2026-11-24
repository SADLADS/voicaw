import React, { useState } from 'react';
import Modal from './Modal';
import ChannelPermissions from './ChannelPermissions';
import PrivateChoice from './PrivateChoice';
import { createCategory, deleteCategory, renameCategory } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { PERMISSIONS, has, memberRank } from '../../utils/permissions';
import { t } from '../../i18n';

// Creating a category (no `category`; with Manage Roles optionally private to some roles) or
// editing one: Overview (rename, delete: its channels stay, out of it) and, with Manage Roles,
// Permissions (ChannelPermissions with `category`: its overrides, copied into its synced
// channels; docs/guilds.md, Category permissions). The server checks every permission again.
export default function CategoryDialog({ guild, category, user, onClose }) {
  const editing = Boolean(category);
  const managesRoles = has(guild.my_permissions, PERMISSIONS.MANAGE_ROLES);
  const managesChannels = has(guild.my_permissions, PERMISSIONS.MANAGE_CHANNELS);
  const tabs = editing ? [
    ...(managesChannels ? [['overview', t('guildAdmin.channelDialog.tabs.overview')]] : []),
    ...(managesRoles && user ? [['permissions', t('guildAdmin.channelDialog.tabs.permissions')]] : []),
  ] : [];
  const [tab, setTab] = useState(tabs[0]?.[0] ?? 'overview');
  const [name, setName] = useState(category?.name ?? '');
  const [isPrivate, setIsPrivate] = useState(false);
  const [privateRoleIds, setPrivateRoleIds] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const myRank = user ? memberRank(guild, user.id, guild.my_role_ids) : 0;
  const grantableRoles = (guild.roles ?? []).filter((r) => !r.is_everyone && r.position < myRank);

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
    run(() => (editing
      ? renameCategory(guild.id, category.id, name.trim())
      : createCategory(guild.id, name.trim(), isPrivate ? { private: true, roleIds: privateRoleIds } : {})));
  }

  return (
    <Modal
      title={editing ? t('guildAdmin.categoryDialog.editTitle') : t('guildAdmin.categoryDialog.createTitle')}
      onClose={onClose}
      className={tab !== 'overview' ? 'channel-dialog wide' : undefined}
      actions={tab !== 'overview' ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.done')}</button>
      ) : (
        <>
          {editing && (
            <button type="button" className="btn btn-outline-danger btn-sm me-auto" disabled={busy} onClick={() => run(() => deleteCategory(guild.id, category.id))}>
              {t('guildAdmin.categoryDialog.delete')}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="category-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !name.trim()}>
            {editing ? t('common.save') : t('guildAdmin.categoryDialog.createTitle')}
          </button>
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
      {tab === 'permissions' && <ChannelPermissions guild={guild} category={category} user={user} />}
      {tab === 'overview' && (
        <form id="category-form" className="vc-form" onSubmit={save}>
          <label htmlFor="category-name">{t('guildAdmin.categoryDialog.name')}</label>
          <input
            id="category-name"
            className="form-control"
            maxLength={100}
            placeholder={t('guildAdmin.categoryDialog.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {editing && <p className="vc-hint">{t('guildAdmin.categoryDialog.deleteHint')}</p>}
          {!editing && managesRoles && user && (
            <PrivateChoice
              label={t('guildAdmin.categoryDialog.private.label')}
              hint={t('guildAdmin.categoryDialog.private.createHint')}
              checked={isPrivate}
              onChange={setIsPrivate}
              roles={grantableRoles}
              roleIds={privateRoleIds}
              onRoleIdsChange={setPrivateRoleIds}
            />
          )}
        </form>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
