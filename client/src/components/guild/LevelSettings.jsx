import React, { useState } from 'react';
import { updateLevelSettings } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import {
  LEVEL_SOURCES, MAX_COOLDOWN, MAX_SOURCE_XP, MAX_XP_PER_LEVEL, NAME_LIMITS, levelName, levelShort, showsXp, xpName,
} from '../../utils/levels';
import { t } from '../../i18n';

// A whole number from an input (empty or nonsense: null).
const wholeNumber = (value) => (/^\d+$/.test(String(value).trim()) ? Number(value) : null);

// Guild Settings → Levels (Manage Guild): on or off, names, XP per level, the member list's
// badge, and what earns XP and how much. Everything is saved at once with Save; the guild's
// new layout brings the result back to everyone.
export default function LevelSettings({ guild }) {
  const saved = guild.levels;
  const [draft, setDraft] = useState(() => ({
    ...saved,
    xpPerLevel: String(saved.xpPerLevel),
    messageCooldown: String(saved.messageCooldown),
    sources: Object.fromEntries(LEVEL_SOURCES.map((key) => [key, { ...saved.sources[key], xp: String(saved.sources[key].xp) }])),
  }));
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key, value) => {
    setStatus(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const setSource = (key, change) => {
    setStatus(null);
    setDraft((d) => ({ ...d, sources: { ...d.sources, [key]: { ...d.sources[key], ...change } } }));
  };

  // Names and amounts as they'd read once saved (the draft's, where it makes sense).
  const perLevel = wholeNumber(draft.xpPerLevel) ?? saved.xpPerLevel;
  const shown = { ...draft, xpPerLevel: perLevel };
  const unit = showsXp(shown) ? xpName(shown) : levelName(shown);

  const numbers = {
    xpPerLevel: wholeNumber(draft.xpPerLevel),
    messageCooldown: wholeNumber(draft.messageCooldown),
    sources: Object.fromEntries(LEVEL_SOURCES.map((key) => [key, wholeNumber(draft.sources[key].xp)])),
  };
  const invalid = numbers.xpPerLevel == null || numbers.xpPerLevel < 1 || numbers.xpPerLevel > MAX_XP_PER_LEVEL ||
    numbers.messageCooldown == null || numbers.messageCooldown > MAX_COOLDOWN ||
    LEVEL_SOURCES.some((key) => numbers.sources[key] == null || numbers.sources[key] > MAX_SOURCE_XP);

  async function save(e) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await updateLevelSettings(guild.id, {
        enabled: draft.enabled,
        xpPerLevel: numbers.xpPerLevel,
        xpName: draft.xpName,
        levelName: draft.levelName,
        levelShort: draft.levelShort,
        showInMemberList: draft.showInMemberList,
        messageCooldown: numbers.messageCooldown,
        sources: Object.fromEntries(LEVEL_SOURCES.map((key) => [key, { enabled: draft.sources[key].enabled, xp: numbers.sources[key] }])),
      });
      setStatus(t('levels.settings.saved'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const nameField = (key, label, fallback, hint) => (
    <div className="level-settings-name">
      <label htmlFor={`level-${key}`}>{label}</label>
      <input
        id={`level-${key}`}
        className="form-control"
        maxLength={NAME_LIMITS[key]}
        placeholder={fallback}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
      />
      <span className="vc-hint">{hint ?? t('levels.settings.default', { value: fallback })}</span>
    </div>
  );

  return (
    <form className="vc-form level-settings" onSubmit={save}>
      <label className="role-toggle">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <span>
          <strong>{t('levels.settings.enabled.label')}</strong>
          <span className="vc-hint">{t('levels.settings.enabled.hint', { xp: xpName(shown) })}</span>
        </span>
      </label>

      <fieldset disabled={!draft.enabled} className="level-settings-body">
        <label htmlFor="level-per">{t('levels.settings.xpPerLevel', { xp: xpName(shown) })}</label>
        <input
          id="level-per"
          className="form-control level-settings-number"
          inputMode="numeric"
          value={draft.xpPerLevel}
          aria-invalid={numbers.xpPerLevel == null || numbers.xpPerLevel < 1}
          onChange={(e) => set('xpPerLevel', e.target.value)}
        />
        <span className="vc-hint">{t('levels.settings.xpPerLevelHint', { xp: xpName(shown) })}</span>

        <h6 className="level-settings-heading">{t('levels.settings.names')}</h6>
        <div className="level-settings-names">
          {showsXp(shown) && nameField('xpName', t('levels.settings.xpName'), t('levels.defaults.xp'))}
          {nameField('levelName', t('levels.settings.levelName'), t('levels.defaults.level'))}
          {nameField('levelShort', t('levels.settings.levelShort'), t('levels.defaults.levelShort'), t('levels.settings.levelShortHint', { short: levelShort(shown) }))}
        </div>

        <label className="role-toggle">
          <input type="checkbox" checked={draft.showInMemberList} onChange={(e) => set('showInMemberList', e.target.checked)} />
          <span>
            <strong>{t('levels.settings.showInMemberList.label')}</strong>
            <span className="vc-hint">{t('levels.settings.showInMemberList.hint')}</span>
          </span>
        </label>

        <h6 className="level-settings-heading">{t('levels.settings.sources', { xp: unit })}</h6>
        <p className="vc-hint">{t('levels.settings.sourcesHint')}</p>
        <ul className="level-sources">
          {LEVEL_SOURCES.map((key) => {
            const source = draft.sources[key];
            const label = t(`levels.settings.source.${key}.label`);
            return (
              <li key={key} className="level-source">
                <label className="role-toggle">
                  <input type="checkbox" checked={source.enabled} onChange={(e) => setSource(key, { enabled: e.target.checked })} />
                  <span>
                    <strong>{label}</strong>
                    <span className="vc-hint">{t(`levels.settings.source.${key}.hint`)}</span>
                  </span>
                </label>
                <span className="level-source-amount">
                  <input
                    className="form-control level-settings-number"
                    inputMode="numeric"
                    aria-label={t('levels.settings.amount', { xp: unit, what: label })}
                    value={source.xp}
                    disabled={!source.enabled}
                    aria-invalid={numbers.sources[key] == null}
                    onChange={(e) => setSource(key, { xp: e.target.value })}
                  />
                  <span>{unit}</span>
                </span>
              </li>
            );
          })}
        </ul>

        <label htmlFor="level-cooldown">{t('levels.settings.cooldown', { xp: unit })}</label>
        <input
          id="level-cooldown"
          className="form-control level-settings-number"
          inputMode="numeric"
          value={draft.messageCooldown}
          aria-invalid={numbers.messageCooldown == null}
          onChange={(e) => set('messageCooldown', e.target.value)}
        />
        <span className="vc-hint">{t('levels.settings.cooldownHint')}</span>
      </fieldset>

      <div className="vc-form-row">
        <button type="submit" className="btn btn-primary btn-sm vc-button" disabled={busy || invalid}>{t('levels.settings.save')}</button>
        {status && <span className="success-msg">{status}</span>}
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </form>
  );
}
