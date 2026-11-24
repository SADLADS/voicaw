import React from 'react';
import { colorToHex } from '../../utils/permissions';
import { t } from '../../i18n';

// "Private channel" / "Private category" when making one (Manage Roles): the switch, and with it
// on, the roles (below yours, `roles`) that may see it. `label` and `hint` are already translated.
export default function PrivateChoice({ label, hint, checked, onChange, roles, roleIds, onRoleIdsChange }) {
  return (
    <>
      <label className="role-toggle private-toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <strong>{label}</strong>
          <span className="vc-hint">{hint}</span>
        </span>
      </label>
      {checked && roles.length > 0 && (
        <fieldset className="private-roles">
          <legend>{t('guildAdmin.channelDialog.private.whoCanSee')}</legend>
          {roles.map((role) => (
            <label key={role.id} className="role-toggle">
              <input
                type="checkbox"
                checked={roleIds.includes(role.id)}
                onChange={(e) => onRoleIdsChange(e.target.checked ? [...roleIds, role.id] : roleIds.filter((id) => id !== role.id))}
              />
              <span className="role-dot" style={{ backgroundColor: role.color != null ? colorToHex(role.color) : undefined }} />
              <span>{role.name}</span>
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
