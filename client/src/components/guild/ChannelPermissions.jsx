import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faSlash, faXmark } from '@fortawesome/free-solid-svg-icons';
import { fetchChannelOverrides, fetchMembers, setChannelOverride } from '../../services/guildService';
import { PERMISSIONS, channelPermissionItems, colorToHex, has, memberRank } from '../../utils/permissions';
import { errorMessage } from '../../utils/guildDisplay';

// Editing a channel → Permissions (Manage Roles): "Private channel" (hides it from
// @everyone), then per-role and per-member overrides, each permission denied (✕), inherited
// (/) or allowed (✓), like Discord. Changes save straight away. Only roles below yours, and
// only permissions you have in this channel, can be changed.
export default function ChannelPermissions({ guild, channel, user }) {
  const [overrides, setOverrides] = useState(null);
  const [members, setMembers] = useState([]);
  const [selected, setSelected] = useState(null); // 'role:<id>' | 'member:<id>'
  const [error, setError] = useState(null);

  const roles = guild.roles ?? [];
  const everyone = roles.find((r) => r.is_everyone);
  const myRank = memberRank(guild, user.id, guild.my_role_ids);
  const myChannelPermissions = channel.my_permissions ?? 0;

  useEffect(() => {
    fetchChannelOverrides(guild.id, channel.id).then(setOverrides).catch((err) => setError(errorMessage(err)));
    fetchMembers(guild.id).then(setMembers).catch(() => {});
  }, [guild.id, channel.id]);

  const find = (type, id) => overrides?.find((o) => o.target_type === type && o.target_id === id) ?? { allow: 0, deny: 0 };

  async function save(type, id, allow, deny) {
    setError(null);
    try {
      await setChannelOverride(guild.id, channel.id, type, id, { allow, deny });
      setOverrides((list) => {
        const rest = list.filter((o) => !(o.target_type === type && o.target_id === id));
        return allow || deny ? [...rest, { target_type: type, target_id: id, allow, deny }] : rest;
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Sets one permission of an override to 'deny' | 'inherit' | 'allow'.
  function setState(type, id, bit, state) {
    const { allow, deny } = find(type, id);
    save(type, id, state === 'allow' ? allow | bit : allow & ~bit, state === 'deny' ? deny | bit : deny & ~bit);
  }

  if (!overrides) return error ? <p className="error-msg" role="alert">{error}</p> : <p className="vc-hint">Loading…</p>;

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
      name: members.find((m) => m.id === o.target_id)?.username ?? 'Member',
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

  return (
    <div className="channel-permissions">
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
          <strong>Private channel</strong>
          <span className="vc-hint">Only the roles and members allowed "View Channel" below (and admins) will see it.</span>
        </span>
      </label>

      <div className="override-editor">
        <div className="override-targets">
          <span className="vc-label">Roles / members</span>
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
              aria-label="Add a role or member"
              value=""
              onChange={(e) => {
                const [type, id] = e.target.value.split(':');
                // An override with nothing set yet: listed once something is changed.
                setOverrides((list) => [...list, { target_type: type, target_id: Number(id), allow: 0, deny: 0 }]);
                setSelected(e.target.value);
              }}
            >
              <option value="">+ Add…</option>
              {addable.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          )}
        </div>

        <div className="override-grid" aria-label={`Permissions for ${current.name}`}>
          {current.locked && <p className="vc-hint">This role is as high as yours or higher.</p>}
          {channelPermissionItems(channel.type).map(([key, label]) => {
            const bit = PERMISSIONS[key];
            const state = has(deny, bit) ? 'deny' : has(allow, bit) ? 'allow' : 'inherit';
            const disabled = current.locked || !has(myChannelPermissions, bit);
            return (
              <div key={key} className="override-row">
                <span>{label}</span>
                <div className="override-states" role="radiogroup" aria-label={label}>
                  {[['deny', faXmark, 'Deny'], ['inherit', faSlash, 'Inherit'], ['allow', faCheck, 'Allow']].map(([value, icon, name]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={state === value}
                      aria-label={`${name} ${label}`}
                      title={name}
                      className={`override-state ${value}${state === value ? ' selected' : ''}`}
                      disabled={disabled}
                      onClick={() => state !== value && setState(current.type, current.id, bit, value)}
                    >
                      <FontAwesomeIcon icon={icon} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
