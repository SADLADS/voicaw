import React, { useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import { LayoutContext } from '../../contexts';
import { acceptInvite, createGuild } from '../../services/guildService';
import { errorMessage, parseInviteCode } from '../../utils/guildDisplay';

// The rail's "+": create a guild, or join one with an invite link.
export default function AddGuildDialog({ onClose }) {
  const navigate = useNavigate();
  const { guildList } = useContext(LayoutContext);
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      const guild = await action();
      guildList.upsertGuild(guild);
      onClose();
      navigate(`/guild/${guild.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function create(e) {
    e.preventDefault();
    if (name.trim()) run(() => createGuild(name.trim()));
  }

  function join(e) {
    e.preventDefault();
    const code = parseInviteCode(invite);
    if (!code) {
      setError("That doesn't look like an invite link.");
      return;
    }
    run(() => acceptInvite(code));
  }

  return (
    <Modal title="Add a guild" onClose={onClose}>
      <form onSubmit={create} className="vc-form">
        <label htmlFor="new-guild-name">Create your own</label>
        <div className="vc-form-row">
          <input
            id="new-guild-name"
            className="form-control"
            placeholder="Guild name"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button type="submit" className="btn btn-primary vc-button" disabled={busy || !name.trim()}>Create</button>
        </div>
      </form>

      <form onSubmit={join} className="vc-form">
        <label htmlFor="join-guild-invite">Have an invite?</label>
        <div className="vc-form-row">
          <input
            id="join-guild-invite"
            className="form-control"
            placeholder="https://voicaw.com/invite/hTKzmak or hTKzmak"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
          <button type="submit" className="btn btn-secondary" disabled={busy || !invite.trim()}>Join</button>
        </div>
      </form>

      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
