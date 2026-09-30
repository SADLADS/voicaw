import React, { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import { createInvite } from '../../services/guildService';
import { errorMessage, inviteLink } from '../../utils/guildDisplay';

const EXPIRY_OPTIONS = [
  [30 * 60, '30 minutes'],
  [60 * 60, '1 hour'],
  [6 * 60 * 60, '6 hours'],
  [12 * 60 * 60, '12 hours'],
  [24 * 60 * 60, '1 day'],
  [7 * 24 * 60 * 60, '7 days'],
  [30 * 24 * 60 * 60, '30 days'],
  [0, 'Never'],
];
const USE_OPTIONS = [[0, 'No limit'], [1, '1 use'], [5, '5 uses'], [10, '10 uses'], [25, '25 uses'], [50, '50 uses'], [100, '100 uses']];

// "Invite people": makes a link straight away (7 days, any number of uses, like Discord), with
// settings for a different one.
export default function InviteDialog({ guild, onClose }) {
  const [maxAge, setMaxAge] = useState(7 * 24 * 60 * 60);
  const [maxUses, setMaxUses] = useState(0);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async (options) => {
    setError(null);
    setCopied(false);
    try {
      setInvite(await createInvite(guild.id, options));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [guild.id]);

  useEffect(() => {
    generate({ maxAge: 7 * 24 * 60 * 60, maxUses: 0 });
  }, [generate]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteLink(invite.code));
      setCopied(true);
    } catch {
      setError("Couldn't copy; select the link and copy it yourself.");
    }
  }

  const link = invite ? inviteLink(invite.code) : '';
  const summary = invite && [
    invite.expires_at ? `Expires ${new Date(invite.expires_at * 1000).toLocaleString()}` : 'Never expires',
    invite.max_uses ? `${invite.max_uses} use${invite.max_uses === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <Modal title={`Invite friends to ${guild.name}`} onClose={onClose}>
      <label htmlFor="invite-link">Send a guild invite link to a friend</label>
      <div className="vc-form-row">
        <input id="invite-link" className="form-control" readOnly value={link} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn-primary vc-button" onClick={copy} disabled={!invite}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {summary && <p className="vc-hint">{summary}</p>}

      <div className="vc-form-row invite-options">
        <label>
          Expire after
          <select className="form-select form-control" value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
            {EXPIRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          Max number of uses
          <select className="form-select form-control" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {USE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => generate({ maxAge, maxUses })}>
        Generate a new link
      </button>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
