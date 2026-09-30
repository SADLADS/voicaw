import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowDown, faArrowUp, faGripVertical, faLock } from '@fortawesome/free-solid-svg-icons';
import { createRole, deleteRole, reorderRoles, updateRole } from '../../services/guildService';
import { PERMISSIONS, PERMISSION_GROUPS, colorToHex, has, hexToColor, memberRank } from '../../utils/permissions';
import { errorMessage } from '../../utils/guildDisplay';

// Discord's role colour swatches.
const SWATCHES = [
  0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b,
  0x11806a, 0x1f8b4c, 0x206694, 0x71368a, 0xad1457, 0xc27c0e, 0xa84300, 0x992d22, 0x979c9f, 0x546e7a,
];

// Server Settings → Roles: the roles top to bottom (drag, or the arrows, to reorder; @everyone
// always last), "Create Role", and an editor for the selected one: name, colour, "display
// separately", permissions. Roles as high as yours or higher are locked, and permissions you
// don't have can't be switched on. `guild` is the live layout (it updates as roles change).
export default function RolesSettings({ guild, user }) {
  const roles = guild.roles ?? [];
  const myRank = memberRank(guild, user.id, guild.my_role_ids);
  const [selectedId, setSelectedId] = useState(() => roles.find((r) => !r.is_everyone && r.position < myRank)?.id ?? roles.at(-1)?.id);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState(null);

  const selected = roles.find((r) => r.id === selectedId) ?? roles.at(-1);
  const editable = selected && selected.position < myRank;
  const others = roles.filter((r) => !r.is_everyone);

  // The editor starts from the selected role as saved.
  useEffect(() => {
    if (!selected) return;
    setDraft({
      name: selected.name,
      color: selected.color,
      hoist: Boolean(selected.hoist),
      mentionable: Boolean(selected.mentionable),
      permissions: selected.permissions,
    });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.name, selected?.color, selected?.hoist, selected?.mentionable, selected?.permissions]);

  async function run(action) {
    setError(null);
    setSaving(true);
    try {
      return await action();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function addRole() {
    const role = await run(() => createRole(guild.id, { name: 'new role' }));
    if (role) setSelectedId(role.id);
  }

  // Moves `roleId` to `index` (top first) among the roles other than @everyone.
  function move(roleId, index) {
    const ids = others.map((r) => r.id).filter((id) => id !== roleId);
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, roleId);
    if (ids.every((id, i) => id === others[i].id)) return;
    run(() => reorderRoles(guild.id, ids));
  }

  function save() {
    const changes = selected.is_everyone
      ? { permissions: draft.permissions }
      : { name: draft.name, color: draft.color, hoist: draft.hoist, mentionable: draft.mentionable, permissions: draft.permissions };
    run(() => updateRole(guild.id, selected.id, changes));
  }

  const dirty = draft && selected && (
    draft.name !== selected.name || draft.color !== selected.color ||
    draft.hoist !== Boolean(selected.hoist) || draft.mentionable !== Boolean(selected.mentionable) ||
    draft.permissions !== selected.permissions
  );

  return (
    <div className="roles-settings">
      <div className="roles-list">
        <button type="button" className="btn btn-primary btn-sm vc-button w-100" onClick={addRole} disabled={saving}>
          Create Role
        </button>
        <p className="vc-hint">Members use the colour of their highest role. Drag to reorder.</p>
        <ul aria-label="Roles">
          {roles.map((role) => {
            const index = others.findIndex((r) => r.id === role.id);
            const locked = role.position >= myRank;
            const movable = !role.is_everyone && !locked;
            return (
              <li
                key={role.id}
                className={`roles-list-item${role.id === selected?.id ? ' selected' : ''}${dragId === role.id ? ' dragging' : ''}`}
                draggable={movable}
                onDragStart={(e) => {
                  setDragId(role.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => {
                  if (dragId != null && !role.is_everyone && !locked) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId != null && dragId !== role.id) move(dragId, index);
                  setDragId(null);
                }}
              >
                <button type="button" className="roles-list-select" onClick={() => setSelectedId(role.id)}>
                  {movable ? <FontAwesomeIcon icon={faGripVertical} className="roles-grip" /> : <span className="roles-grip" />}
                  <span className="role-dot" style={{ backgroundColor: role.color != null ? colorToHex(role.color) : undefined }} />
                  <span className="roles-list-name">{role.name}</span>
                  {locked && !role.is_everyone && <FontAwesomeIcon icon={faLock} className="roles-lock" title="Above your highest role" />}
                </button>
                {movable && role.id === selected?.id && (
                  <span className="roles-move">
                    <button type="button" aria-label={`Move ${role.name} up`} disabled={index === 0 || others[index - 1].position >= myRank} onClick={() => move(role.id, index - 1)}>
                      <FontAwesomeIcon icon={faArrowUp} />
                    </button>
                    <button type="button" aria-label={`Move ${role.name} down`} disabled={index === others.length - 1} onClick={() => move(role.id, index + 1)}>
                      <FontAwesomeIcon icon={faArrowDown} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {selected && draft && (
        <div className="role-editor" aria-label={`Edit ${selected.name}`}>
          <h6>{selected.is_everyone ? 'Default permissions (@everyone)' : `Edit role — ${selected.name}`}</h6>
          {!editable && <p className="vc-hint">This role is as high as your highest role, so you can't change it.</p>}
          {Boolean(selected.is_everyone) && <p className="vc-hint">Everyone in the server has these, whatever other roles they have.</p>}

          {!selected.is_everyone && (
            <>
              <label className="vc-label" htmlFor="role-name">Role name</label>
              <input
                id="role-name"
                className="form-control"
                maxLength={100}
                value={draft.name}
                disabled={!editable}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />

              <span className="vc-label">Role colour</span>
              <div className="role-colors" role="radiogroup" aria-label="Role colour">
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.color == null}
                  aria-label="Default colour"
                  className={`role-color default${draft.color == null ? ' selected' : ''}`}
                  disabled={!editable}
                  onClick={() => setDraft({ ...draft, color: null })}
                />
                {SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={draft.color === color}
                    aria-label={colorToHex(color)}
                    className={`role-color${draft.color === color ? ' selected' : ''}`}
                    style={{ backgroundColor: colorToHex(color) }}
                    disabled={!editable}
                    onClick={() => setDraft({ ...draft, color })}
                  />
                ))}
                <label className="role-color custom" title="Custom colour">
                  <input
                    type="color"
                    aria-label="Custom colour"
                    value={colorToHex(draft.color ?? 0x99aab5)}
                    disabled={!editable}
                    onChange={(e) => setDraft({ ...draft, color: hexToColor(e.target.value) })}
                  />
                </label>
              </div>

              <label className="role-toggle">
                <input type="checkbox" checked={draft.hoist} disabled={!editable} onChange={(e) => setDraft({ ...draft, hoist: e.target.checked })} />
                <span>
                  <strong>Display role members separately from online members</strong>
                </span>
              </label>

              <label className="role-toggle">
                <input type="checkbox" checked={draft.mentionable} disabled={!editable} onChange={(e) => setDraft({ ...draft, mentionable: e.target.checked })} />
                <span>
                  <strong>Allow anyone to @mention this role</strong>
                  <small className="vc-hint d-block">
                    Members with "Mention @everyone, @here and All Roles" can always mention it.
                  </small>
                </span>
              </label>
            </>
          )}

          <div className="role-permissions">
            {PERMISSION_GROUPS.map((group) => (
              <section key={group.title}>
                <h6 className="vc-label">{group.title}</h6>
                {group.items.map(([key, label, description]) => {
                  const bit = PERMISSIONS[key];
                  const on = has(draft.permissions, bit);
                  // You can switch off anything on a role below you, but only switch on what you have.
                  const allowed = editable && (on || has(guild.my_permissions, bit));
                  return (
                    <label key={key} className="role-toggle">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!allowed}
                        onChange={(e) => setDraft({ ...draft, permissions: e.target.checked ? draft.permissions | bit : draft.permissions & ~bit })}
                      />
                      <span>
                        <strong>{label}</strong>
                        <span className="vc-hint">{description}</span>
                      </span>
                    </label>
                  );
                })}
              </section>
            ))}
          </div>

          {error && <p className="error-msg" role="alert">{error}</p>}
          {editable && (
            <div className="role-editor-actions">
              {!selected.is_everyone && (
                <button
                  type="button"
                  className="btn btn-outline-danger btn-sm me-auto"
                  disabled={saving}
                  onClick={async () => {
                    const deleted = await run(async () => {
                      await deleteRole(guild.id, selected.id);
                      return true;
                    });
                    if (deleted) setSelectedId(roles.at(-1)?.id);
                  }}
                >
                  Delete role
                </button>
              )}
              <button type="button" className="btn btn-secondary btn-sm" disabled={!dirty || saving} onClick={() => setDraft({ name: selected.name, color: selected.color, hoist: Boolean(selected.hoist), permissions: selected.permissions })}>
                Reset
              </button>
              <button type="button" className="btn btn-primary btn-sm vc-button" disabled={!dirty || saving || !draft.name.trim()} onClick={save}>
                Save changes
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
