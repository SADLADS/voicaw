import React, { useContext, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { LayoutContext } from '../../contexts';
import GuildIcon from './GuildIcon';
import {
  deleteGuild,
  fetchBans,
  fetchInvites,
  revokeInvite,
  unbanMember,
  updateGuild,
  uploadGuildIcon,
} from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';

const MAX_ICON_BYTES = 8 * 1024 * 1024;

// Server settings (owner only): name and icon, the invites in use, bans, and deleting it.
export default function GuildSettingsDialog({ guild, onClose }) {
  const { guildList } = useContext(LayoutContext);
  const [name, setName] = useState(guild.name);
  const [invites, setInvites] = useState(null);
  const [bans, setBans] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [deleteText, setDeleteText] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    fetchInvites(guild.id).then(setInvites).catch((err) => setError(errorMessage(err)));
    fetchBans(guild.id).then(setBans).catch((err) => setError(errorMessage(err)));
  }, [guild.id]);

  async function run(action, done) {
    setError(null);
    setStatus(null);
    try {
      await action();
      if (done) setStatus(done);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function saveName(e) {
    e.preventDefault();
    if (name.trim() && name.trim() !== guild.name) run(() => updateGuild(guild.id, { name: name.trim() }), 'Saved.');
  }

  function pickIcon(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('The icon must be an image.');
    if (file.size > MAX_ICON_BYTES) return setError('The icon must be under 8 MB.');
    run(() => uploadGuildIcon(guild.id, file), 'Icon updated.');
  }

  return (
    <Modal title="Server settings" onClose={onClose} className="guild-settings-dialog">
      <section>
        <h6>Overview</h6>
        <div className="guild-settings-overview">
          <button type="button" className="guild-settings-icon" onClick={() => fileInput.current?.click()} title="Change icon">
            <GuildIcon guild={guild} />
            <span>Change</span>
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickIcon} />
          <form className="vc-form flex-grow-1" onSubmit={saveName}>
            <label htmlFor="guild-name">Server name</label>
            <div className="vc-form-row">
              <input id="guild-name" className="form-control" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className="btn btn-primary btn-sm vc-button" disabled={!name.trim() || name.trim() === guild.name}>Save</button>
            </div>
            {guild.icon_version > 0 && (
              <button type="button" className="btn btn-link btn-sm p-0" onClick={() => run(() => updateGuild(guild.id, { icon: null }), 'Icon removed.')}>
                Remove icon
              </button>
            )}
          </form>
        </div>
        {status && <p className="success-msg">{status}</p>}
        {error && <p className="error-msg" role="alert">{error}</p>}
      </section>

      <section>
        <h6>Invites</h6>
        {invites == null ? <p className="vc-hint">Loading…</p> : invites.length === 0 ? <p className="vc-hint">No active invites.</p> : (
          <ul className="guild-settings-list">
            {invites.map((invite) => (
              <li key={invite.code}>
                <span className="guild-settings-code">{invite.code}</span>
                <span className="vc-hint">
                  by {invite.creator_username} · {invite.uses}{invite.max_uses ? `/${invite.max_uses}` : ''} {(invite.max_uses || invite.uses) === 1 ? 'use' : 'uses'}
                  {invite.expires_at ? ` · expires ${new Date(invite.expires_at * 1000).toLocaleString()}` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-outline-danger btn-sm"
                  onClick={() => run(async () => {
                    await revokeInvite(invite.code);
                    setInvites((list) => list.filter((i) => i.code !== invite.code));
                  })}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h6>Bans</h6>
        {bans == null ? <p className="vc-hint">Loading…</p> : bans.length === 0 ? <p className="vc-hint">Nobody is banned.</p> : (
          <ul className="guild-settings-list">
            {bans.map((ban) => (
              <li key={ban.id}>
                <span>{ban.username}</span>
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={() => run(async () => {
                    await unbanMember(guild.id, ban.id);
                    setBans((list) => list.filter((b) => b.id !== ban.id));
                  })}
                >
                  Unban
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="guild-settings-danger">
        <h6>Delete server</h6>
        <p className="vc-hint">This deletes every channel and message. It can't be undone. Type the server's name to confirm.</p>
        <div className="vc-form-row">
          <input className="form-control" aria-label="Server name to confirm" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} />
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={deleteText !== guild.name}
            onClick={() => run(async () => {
              await deleteGuild(guild.id);
              guildList.removeGuild(guild.id);
            })}
          >
            Delete server
          </button>
        </div>
      </section>
    </Modal>
  );
}
