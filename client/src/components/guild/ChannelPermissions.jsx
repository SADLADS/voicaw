import React, { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { faCheck, faSlash, faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  fetchCategoryOverrides, fetchChannelOverrides, fetchMembers, setCategoryOverride, setChannelOverride, syncChannelPermissions,
} from '../../services/guildService';
import { PERMISSIONS, channelPermissionItems, colorToHex, has, memberRank, sameOverrides } from '../../utils/permissions';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// Editing a channel or a category (`category` instead of `channel`) → Permissions (Manage
// Roles): "Private channel" (hides it from @everyone), then per-role and per-member overrides,
// each permission denied (✕), inherited (/) or allowed (✓), like Discord. Changes save straight
// away. Only roles below yours, and only permissions you have here, can be changed. A category's
// overrides are copied into its channels that were synced with it (docs/guilds.md, Category
// permissions); a channel in a category says whether it's synced, with Sync now if not.
export default function ChannelPermissions({ guild, channel, category, user }) {
  const target = category ?? channel;
  const parent = channel?.category_id != null ? guild.categories?.find((c) => c.id === channel.category_id) : null;
  const [overrides, setOverrides] = useState(null);
  const [parentOverrides, setParentOverrides] = useState(null);
  const [syncedNote, setSyncedNote] = useState(null);
  const [members, setMembers] = useState([]);
  const [selected, setSelected] = useState(null); // 'role:<id>' | 'member:<id>'
  const [error, setError] = useState(null);

  const roles = guild.roles ?? [];
  const everyone = roles.find((r) => r.is_everyone);
  const myRank = memberRank(guild, user.id, guild.my_role_ids);
  const myChannelPermissions = target.my_permissions ?? 0;
  const parentId = parent?.id ?? null;
  const categoryId = category?.id ?? null;
  const channelId = channel?.id ?? null;

  useEffect(() => {
    const load = categoryId != null ? fetchCategoryOverrides(guild.id, categoryId) : fetchChannelOverrides(guild.id, channelId);
    load.then(setOverrides).catch((err) => setError(errorMessage(err)));
    if (parentId != null) fetchCategoryOverrides(guild.id, parentId).then(setParentOverrides).catch(() => {});
    fetchMembers(guild.id).then(setMembers).catch(() => {});
  }, [guild.id, categoryId, channelId, parentId]);

  const find = (type, id) => overrides?.find((o) => o.target_type === type && o.target_id === id) ?? { allow: 0, deny: 0 };

  async function save(type, id, allow, deny) {
    setError(null);
    setSyncedNote(null);
    try {
      if (category) {
        const saved = await setCategoryOverride(guild.id, category.id, type, id, { allow, deny });
        setSyncedNote(saved?.synced_channels ?? 0);
      } else {
        await setChannelOverride(guild.id, channel.id, type, id, { allow, deny });
      }
      setOverrides((list) => {
        const rest = list.filter((o) => !(o.target_type === type && o.target_id === id));
        return allow || deny ? [...rest, { target_type: type, target_id: id, allow, deny }] : rest;
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function syncNow() {
    setError(null);
    try {
      await syncChannelPermissions(guild.id, channel.id);
      setOverrides(parentOverrides.map((o) => ({ ...o })));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Sets one permission of an override to 'deny' | 'inherit' | 'allow'.
  function setState(type, id, bit, state) {
    const { allow, deny } = find(type, id);
    save(type, id, state === 'allow' ? allow | bit : allow & ~bit, state === 'deny' ? deny | bit : deny & ~bit);
  }

  if (!overrides) return error ? <p className="error-msg" role="alert">{error}</p> : <p className="vc-hint">{t('common.loading')}</p>;

  const everyoneOverride = find('role', everyone.id);
  const isPrivate = has(everyoneOverride.deny, PERMISSIONS.VIEW_CHANNEL);
  const canChangeView = has(myChannelPermissions, PERMISSIONS.VIEW_CHANNEL);

  // The overrides listed: @everyone first, then roles in order, then members.
  const entries = [
    { key: `role:${everyone.id}`, type: 'role', id: everyone.id, name: '@everyone', locked: false },
    ...roles.filter((r) => !r.is_everyone && overrides.some((o) => o.target_type === 'role' && o.target_id === r.id))
      .map((r) => ({ key: `role:${r.id}`, type: 'role', id: r.id, name: r.name, color: r.color, locked: r.position >= myRank })),
    ...overrides.filter((o) => o.target_type === 'member').map((o) => ({
      key: `member:${o.target_id}`,
      type: 'member',
      id: o.target_id,
      name: members.find((m) => m.id === o.target_id)?.username ?? t('guildAdmin.channelPermissions.member'),
      locked: false,
    })),
  ];
  const current = entries.find((e) => e.key === selected) ?? entries[0];
  const addable = [
    ...roles.filter((r) => !r.is_everyone && r.position < myRank && !entries.some((e) => e.key === `role:${r.id}`))
      .map((r) => ({ value: `role:${r.id}`, label: r.name })),
    ...members.filter((m) => !entries.some((e) => e.key === `member:${m.id}`))
      .map((m) => ({ value: `member:${m.id}`, label: `@${m.username}` })),
  ];

  const { allow, deny } = find(current.type, current.id);
  const synced = parentOverrides && sameOverrides(overrides, parentOverrides);

  return (
    <div className="channel-permissions">
      {parent && parentOverrides && (
        <div className={`permissions-sync${synced ? ' synced' : ''}`} role="status">
          <span>
            {synced
              ? t('guildAdmin.channelPermissions.sync.synced', { category: parent.name })
              : t('guildAdmin.channelPermissions.sync.notSynced', { category: parent.name })}
          </span>
          {!synced && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={syncNow}>{t('guildAdmin.channelPermissions.sync.now')}</button>
          )}
        </div>
      )}
      {category && <p className="vc-hint">{t('guildAdmin.channelPermissions.categoryHint')}</p>}
      <label className="role-toggle private-toggle">
        <input
          type="checkbox"
          checked={isPrivate}
          disabled={!canChangeView}
          onChange={(e) => {
            const bit = PERMISSIONS.VIEW_CHANNEL;
            save('role', everyone.id, everyoneOverride.allow & ~bit, e.target.checked ? everyoneOverride.deny | bit : everyoneOverride.deny & ~bit);
          }}
        />
        <span>
          <strong>{category ? t('guildAdmin.categoryDialog.private.label') : t('guildAdmin.channelDialog.private.label')}</strong>
          <span className="vc-hint">{category ? t('guildAdmin.categoryDialog.private.hint') : t('guildAdmin.channelPermissions.privateHint')}</span>
        </span>
      </label>

      <div className="override-editor">
        <div className="override-targets">
          <span className="vc-label">{t('guildAdmin.channelPermissions.targets')}</span>
          <ul>
            {entries.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className={`override-target${entry.key === current.key ? ' selected' : ''}`}
                  onClick={() => setSelected(entry.key)}
                >
                  {entry.type === 'role' && <span className="role-dot" style={{ backgroundColor: entry.color != null ? colorToHex(entry.color) : undefined }} />}
                  {entry.type === 'member' ? `@${entry.name}` : entry.name}
                </button>
              </li>
            ))}
          </ul>
          {addable.length > 0 && (
            <select
              className="form-select form-control form-control-sm"
              aria-label={t('guildAdmin.channelPermissions.add')}
              value=""
              onChange={(e) => {
                const [type, id] = e.target.value.split(':');
                // An override with nothing set yet: listed once something is changed.
                setOverrides((list) => [...list, { target_type: type, target_id: Number(id), allow: 0, deny: 0 }]);
                setSelected(e.target.value);
              }}
            >
              <option value="">{t('guildAdmin.channelPermissions.addOption')}</option>
              {addable.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          )}
        </div>

        <div className="override-grid" aria-label={t('guildAdmin.channelPermissions.gridLabel', { name: current.name })}>
          {current.locked && <p className="vc-hint">{t('guildAdmin.channelPermissions.locked')}</p>}
          {channelPermissionItems(category ? 'category' : channel.type).map(([key, labelKey]) => {
            const label = t(`guildAdmin.channelPermissions.items.${labelKey}`);
            const bit = PERMISSIONS[key];
            const state = has(deny, bit) ? 'deny' : has(allow, bit) ? 'allow' : 'inherit';
            const disabled = current.locked || !has(myChannelPermissions, bit);
            return (
              <div key={key} className="override-row">
                <span>{label}</span>
                <div className="override-states" role="radiogroup" aria-label={label}>
                  {[['deny', faXmark], ['inherit', faSlash], ['allow', faCheck]].map(([value, icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={state === value}
                      aria-label={t(`guildAdmin.channelPermissions.states.${value}.aria`, { permission: label })}
                      title={t(`guildAdmin.channelPermissions.states.${value}.label`)}
                      className={`override-state ${value}${state === value ? ' selected' : ''}`}
                      disabled={disabled}
                      onClick={() => state !== value && setState(current.type, current.id, bit, value)}
                    >
                      <Icon icon={icon} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {syncedNote != null && syncedNote > 0 && (
        <p className="vc-hint" role="status">{t('guildAdmin.channelPermissions.syncedChannels', { count: syncedNote })}</p>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
