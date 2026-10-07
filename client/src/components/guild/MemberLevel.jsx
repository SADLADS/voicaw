import React, { useEffect, useState } from 'react';
import { changeMemberXp, fetchMemberLevel } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { levelName, levelProgress, showsXp, xpName } from '../../utils/levels';
import { nameOf } from '../../utils/profiles';
import { t } from '../../i18n';

const formatNumber = (n) => new Intl.NumberFormat().format(n);

// The member card's level (guild with levels on): their level and rank, how far into it they
// are (unless the guild counts levels only), and with Manage Levels a form to set or add to
// their level or XP. The member list's `member.xp` only changes with their level (or by hand),
// so the card fetches their XP and rank as it opens, and again on each such change.
export default function MemberLevel({ guild, member, canEdit }) {
  const settings = guild.levels;
  const [entry, setEntry] = useState(null);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState('set');
  const [unit, setUnit] = useState('level');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMemberLevel(guild.id, member.id)
      .then((fetched) => { if (!cancelled) setEntry(fetched); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [guild.id, member.id, member.xp]);

  const { level, into, needed } = levelProgress(entry?.xp ?? member.xp, settings);
  const rank = entry?.rank ?? null;
  const withXp = showsXp(settings);
  const value = Number(amount);
  const valid = amount.trim() !== '' && Number.isSafeInteger(value) && (mode === 'add' || value >= 0);

  async function save(e) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const key = { set: { level: 'level', xp: 'xp' }, add: { level: 'addLevels', xp: 'addXp' } }[mode][withXp ? unit : 'level'];
      await changeMemberXp(guild.id, member.id, { [key]: value });
      setEditing(false);
      setAmount('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="member-card-level">
      <div className="member-card-level-top">
        <span className="member-card-label">{t('levels.card.level', { name: levelName(settings), level: formatNumber(level) })}</span>
        {rank != null && <span className="member-card-rank">{t('levels.card.rank', { rank: formatNumber(rank) })}</span>}
        {canEdit && !editing && (
          <button type="button" className="btn btn-link btn-sm p-0 ms-auto" onClick={() => setEditing(true)}>{t('levels.card.change')}</button>
        )}
      </div>
      {withXp && (
        <>
          <div className="level-progress" role="progressbar" aria-valuemin={0} aria-valuemax={needed} aria-valuenow={into}>
            <span style={{ width: `${(into / needed) * 100}%` }} />
          </div>
          <div className="vc-hint">{t('levels.card.progress', { into: formatNumber(into), needed: formatNumber(needed), xp: xpName(settings) })}</div>
        </>
      )}
      {editing && (
        <form className="member-level-edit" onSubmit={save} aria-label={t('levels.card.editLabel', { name: nameOf(member), what: withXp ? xpName(settings) : levelName(settings) })}>
          <select className="form-select form-select-sm" value={mode} onChange={(e) => setMode(e.target.value)} aria-label={t('levels.card.change')}>
            <option value="set">{t('levels.card.set')}</option>
            <option value="add">{t('levels.card.add')}</option>
          </select>
          <input
            className="form-control form-control-sm"
            inputMode="numeric"
            aria-label={t('levels.card.amount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
          {withXp && (
            <select className="form-select form-select-sm" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label={t('levels.card.amount')}>
              <option value="level">{levelName(settings)}</option>
              <option value="xp">{xpName(settings)}</option>
            </select>
          )}
          <button type="submit" className="btn btn-primary btn-sm vc-button" disabled={!valid || busy}>{t('common.save')}</button>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { setEditing(false); setError(null); }}>{t('levels.card.cancel')}</button>
        </form>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
