import React, { useContext, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import GuildIcon from './GuildIcon';
import RolesSettings from './RolesSettings';
import EmojiSettings from './EmojiSettings';
import { LayoutContext } from '../../contexts';
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
import { formatDateTime } from '../../utils/dateFormat';
import { PERMISSIONS, has } from '../../utils/permissions';

const MAX_ICON_BYTES = 8 * 1024 * 1024;

function Overview({ guild, isOwner }) {
  const { guildList } = useContext(LayoutContext);
  const [name, setName] = useState(guild.name);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [deleteText, setDeleteText] = useState('');
  const fileInput = useRef(null);

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
    <>
      <section>
        <div className="guild-settings-overview">
          <button type="button" className="guild-settings-icon" onClick={() => fileInput.current?.click()} title="Change icon">
            <GuildIcon guild={guild} />
            <span>Change</span>
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickIcon} />
          <form className="vc-form flex-grow-1" onSubmit={saveName}>
            <label htmlFor="guild-name">Guild name</label>
            <div className="vc-form-row">
              <input id="guild-name" className="form-control" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className="btn btn-primary btn-sm vc-button" disabled={!name.trim() || name.trim() === guild.name}>Save</button>
            </div>
            {guild.icon_version > 0 && (
              <button type="button" className="btn btn-link btn-sm p-0 align-self-start" onClick={() => run(() => updateGuild(guild.id, { icon: null }), 'Icon removed.')}>
                Remove icon
              </button>
            )}
          </form>
        </div>
        {status && <p className="success-msg">{status}</p>}
        {error && <p className="error-msg" role="alert">{error}</p>}
      </section>

      {isOwner && (
        <section className="guild-settings-danger">
          <h6>Delete guild</h6>
          <p className="vc-hint">This deletes every channel and message. It can't be undone. Type the guild's name to confirm.</p>
          <div className="vc-form-row">
            <input className="form-control" aria-label="Guild name to confirm" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} />
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={deleteText !== guild.name}
              onClick={() => run(async () => {
                await deleteGuild(guild.id);
                guildList.removeGuild(guild.id);
              })}
            >
              Delete guild
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function Invites({ guild }) {
  const [invites, setInvites] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchInvites(guild.id).then(setInvites).catch((err) => setError(errorMessage(err)));
  }, [guild.id]);

  if (error) return <p className="error-msg" role="alert">{error}</p>;
  if (invites == null) return <p className="vc-hint">Loading…</p>;
  if (invites.length === 0) return <p className="vc-hint">No active invites.</p>;
  return (
    <ul className="guild-settings-list">
      {invites.map((invite) => (
        <li key={invite.code}>
          <span className="guild-settings-code">{invite.code}</span>
          <span className="vc-hint">
            by {invite.creator_username} · {invite.uses}{invite.max_uses ? `/${invite.max_uses}` : ''} {(invite.max_uses || invite.uses) === 1 ? 'use' : 'uses'}
            {invite.expires_at ? ` · expires ${formatDateTime(invite.expires_at * 1000)}` : ''}
          </span>
          <button
            type="button"
            className="btn btn-outline-danger btn-sm"
            onClick={async () => {
              try {
                await revokeInvite(invite.code);
                setInvites((list) => list.filter((i) => i.code !== invite.code));
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Revoke
          </button>
        </li>
      ))}
    </ul>
  );
}

function Bans({ guild }) {
  const [bans, setBans] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchBans(guild.id).then(setBans).catch((err) => setError(errorMessage(err)));
  }, [guild.id]);

  if (error) return <p className="error-msg" role="alert">{error}</p>;
  if (bans == null) return <p className="vc-hint">Loading…</p>;
  if (bans.length === 0) return <p className="vc-hint">Nobody is banned.</p>;
  return (
    <ul className="guild-settings-list">
      {bans.map((ban) => (
        <li key={ban.id}>
          <span>{ban.username}</span>
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={async () => {
              try {
                await unbanMember(guild.id, ban.id);
                setBans((list) => list.filter((b) => b.id !== ban.id));
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Unban
          </button>
        </li>
      ))}
    </ul>
  );
}

// Guild settings: the tabs you have permission for (Overview and Invites: Manage Guild;
// Roles: Manage Roles; Emoji: Manage Emoji; Bans: Ban Members). Deleting the guild is the owner's alone.
export default function GuildSettingsDialog({ guild, user, onClose }) {
  const can = (bit) => has(guild.my_permissions, bit);
  const tabs = [
    can(PERMISSIONS.MANAGE_GUILD) && ['overview', 'Overview'],
    can(PERMISSIONS.MANAGE_ROLES) && ['roles', 'Roles'],
    can(PERMISSIONS.MANAGE_EMOJIS) && ['emoji', 'Emoji'],
    can(PERMISSIONS.MANAGE_GUILD) && ['invites', 'Invites'],
    can(PERMISSIONS.BAN_MEMBERS) && ['bans', 'Bans'],
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.[0]);

  return (
    <Modal title="Guild settings" onClose={onClose} className="guild-settings-dialog">
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
      <div className="settings-tab-body" role="tabpanel">
        {tab === 'overview' && <Overview guild={guild} isOwner={guild.owner === user.id} />}
        {tab === 'roles' && <RolesSettings guild={guild} user={user} />}
        {tab === 'emoji' && <EmojiSettings guild={guild} />}
        {tab === 'invites' && <Invites guild={guild} />}
        {tab === 'bans' && <Bans guild={guild} />}
        {tabs.length === 0 && <p className="vc-hint">You don't have permission to change anything here.</p>}
      </div>
    </Modal>
  );
}
