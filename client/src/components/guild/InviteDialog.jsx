import React, { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import { createInvite, fetchVanityInvite } from '../../services/guildService';
import { errorMessage, inviteLink } from '../../utils/guildDisplay';
import { formatDateTime } from '../../utils/dateFormat';
import { t } from '../../i18n';

const EXPIRY_OPTIONS = [
  [30 * 60, t('guildAdmin.auditLog.age.minutes', { count: 30 })],
  [60 * 60, t('guildAdmin.auditLog.age.hours', { count: 1 })],
  [6 * 60 * 60, t('guildAdmin.auditLog.age.hours', { count: 6 })],
  [12 * 60 * 60, t('guildAdmin.auditLog.age.hours', { count: 12 })],
  [24 * 60 * 60, t('guildAdmin.auditLog.age.days', { count: 1 })],
  [7 * 24 * 60 * 60, t('guildAdmin.auditLog.age.days', { count: 7 })],
  [30 * 24 * 60 * 60, t('guildAdmin.auditLog.age.days', { count: 30 })],
  [0, t('guildAdmin.invite.never')],
];
const USE_OPTIONS = [
  [0, t('guildAdmin.invite.noLimit')],
  ...[1, 5, 10, 25, 50, 100].map((count) => [count, t('guildAdmin.invite.uses', { count })]),
];

// "Invite people": makes a link straight away (7 days, any number of uses, like Discord), with
// settings for a different one, and the guild's vanity URL if it has one.
export default function InviteDialog({ guild, onClose }) {
  const [maxAge, setMaxAge] = useState(7 * 24 * 60 * 60);
  const [maxUses, setMaxUses] = useState(0);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [vanity, setVanity] = useState(null);
  const [vanityCopied, setVanityCopied] = useState(false);

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

  useEffect(() => {
    fetchVanityInvite(guild.id).then((data) => setVanity(data.code)).catch(() => {});
  }, [guild.id]);

  async function copy(code, done) {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      done(true);
    } catch {
      setError(t('guildAdmin.invite.copyFailed'));
    }
  }

  const link = invite ? inviteLink(invite.code) : '';
  const summary = invite && [
    invite.expires_at ? t('guildAdmin.invite.expires', { date: formatDateTime(invite.expires_at * 1000) }) : t('guildAdmin.auditLog.changes.neverExpires'),
    invite.max_uses ? t('guildAdmin.invite.uses', { count: invite.max_uses }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <Modal title={t('guildAdmin.invite.title', { name: guild.name })} onClose={onClose}>
      <label htmlFor="invite-link">{t('guildAdmin.invite.linkLabel')}</label>
      <div className="vc-form-row">
        <input id="invite-link" className="form-control" readOnly value={link} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn-primary vc-button" onClick={() => copy(invite.code, setCopied)} disabled={!invite}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      {summary && <p className="vc-hint">{summary}</p>}

      {vanity && (
        <>
          <label htmlFor="invite-vanity-link">{t('guildAdmin.invite.vanityLabel')}</label>
          <div className="vc-form-row">
            <input id="invite-vanity-link" className="form-control" readOnly value={inviteLink(vanity)} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn btn-secondary" onClick={() => copy(vanity, setVanityCopied)}>
              {vanityCopied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <p className="vc-hint">{t('guildAdmin.invite.vanityHint')}</p>
        </>
      )}

      <div className="vc-form-row invite-options">
        <label>
          {t('guildAdmin.invite.expireAfter')}
          <select className="form-select form-control" value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
            {EXPIRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          {t('guildAdmin.invite.maxUses')}
          <select className="form-select form-control" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {USE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => generate({ maxAge, maxUses })}>
        {t('guildAdmin.invite.generate')}
      </button>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
