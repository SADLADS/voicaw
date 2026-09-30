import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../../assets/css/guilds.css';
import '../../assets/css/groups.css';
import Modal from '../guild/Modal';
import UserPicker from './UserPicker';
import { createGroup } from '../../services/groupKeys';
import { MAX_GROUP_MEMBERS } from '../../services/groupCrypto';
import { showContent } from '../../utils/mobilePanes';

// Pick two or more people (and optionally a name) for a new group DM.
export default function NewGroupDialog({ user, users, onCreated, onClose }) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const group = await createGroup(user, users.filter((u) => selected.has(u.id)), name);
      onCreated?.(group);
      onClose();
      navigate(`/dm/g/${group.id}`);
      showContent();
    } catch (err) {
      setError(err.response?.data?.error ?? err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New Group"
      className="group-dialog"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm vc-button" onClick={create} disabled={busy || selected.size < 2}>
            {busy ? 'Creating…' : 'Create Group'}
          </button>
        </>
      )}
    >
      <p className="vc-hint">
        Pick at least two people (up to {MAX_GROUP_MEMBERS - 1}). Messages and calls are end-to-end encrypted.
      </p>
      <input
        className="form-control group-name-input"
        placeholder="Group name (optional)"
        aria-label="Group name"
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <UserPicker users={users} selected={selected} onChange={setSelected} max={MAX_GROUP_MEMBERS - 1} />
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
