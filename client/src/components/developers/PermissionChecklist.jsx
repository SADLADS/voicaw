import React from 'react';
import { BOT_PERMISSION_GROUPS } from '../../utils/botPermissions';
import { t } from '../../i18n';

// Bot permissions as ticks, in groups. `selected` is a Set of names; `only` limits the list to
// those names (the authorise page shows only what's asked for); `disabled(p)` greys one out
// with `disabledHint`.
export default function PermissionChecklist({ selected, onChange, only = null, disabled = () => false, disabledHint = '' }) {
  const toggle = (name, on) => {
    const next = new Set(selected);
    if (on) next.add(name);
    else next.delete(name);
    onChange(next);
  };

  return (
    <div className="dev-permissions">
      {BOT_PERMISSION_GROUPS.map((group) => {
        const permissions = group.permissions.filter((p) => !only || only.has(p.name));
        if (!permissions.length) return null;
        return (
          <fieldset key={group.id} className="dev-permission-group">
            <legend>{t(`developers.groups.${group.id}`)}</legend>
            {permissions.map((p) => {
              const off = disabled(p);
              return (
                <label key={p.name} className={`dev-permission${off ? ' disabled' : ''}`} title={off ? disabledHint : undefined}>
                  <input
                    type="checkbox"
                    checked={selected.has(p.name) && !off}
                    disabled={off}
                    onChange={(e) => toggle(p.name, e.target.checked)}
                  />
                  <span>{t(`developers.permissions.${p.name}`)}</span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
