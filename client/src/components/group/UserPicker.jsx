import React, { useState } from 'react';
import UserAvatar from '../voice/UserAvatar';
import { isDeleted, nameOf, useProfiles } from '../../utils/profiles';

// A searchable list of people to tick (new group, adding members). `users`: rows from the DM
// list (deleted accounts left out); `selected`: Set of ids; `max`: how many may be ticked.
export default function UserPicker({ users, selected, onChange, max }) {
  useProfiles();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = users.filter((u) => !isDeleted(u)).filter((u) => u.username.toLowerCase().includes(q) || nameOf(u).toLowerCase().includes(q));
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < max) next.add(id);
    onChange(next);
  };
  return (
    <div className="user-picker">
      <input
        type="search"
        className="form-control"
        placeholder="Search people"
        aria-label="Search people"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="user-picker-list">
        {shown.map((u) => (
          <li key={u.id}>
            <label className={`user-picker-row${selected.has(u.id) ? ' selected' : ''}`}>
              <UserAvatar userId={u.id} className="user-picker-avatar" />
              <span className="user-picker-name">{nameOf(u)}</span>
              <input
                type="checkbox"
                checked={selected.has(u.id)}
                disabled={!selected.has(u.id) && selected.size >= max}
                onChange={() => toggle(u.id)}
              />
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="user-picker-empty">Nobody found.</li>}
      </ul>
    </div>
  );
}
