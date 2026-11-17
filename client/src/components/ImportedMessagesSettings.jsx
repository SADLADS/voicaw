import React, { useEffect, useState } from 'react';
import { linkedToMe, unlinkAll, unlinkImportedAuthor } from '../services/historyImport/importService';
import { setPreference, usePreferences } from '../utils/preferences';
import { errorText } from '../utils/errors';
import ConfirmDialog from './guild/ConfirmDialog';
import { t } from '../i18n';

// Settings → Privacy → Imported messages: the guilds whose history imports show you as the
// author of old messages (docs/guilds.md, History imports), each one unlinked here or all at
// once (they then show the archive's name, as if nobody had linked you), and whether future
// imports may link you at all (server/preferences.js importOptOut, off by default).
export default function ImportedMessagesSettings() {
  const prefs = usePreferences();
  const [linked, setLinked] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null); // an author row, or 'all'

  const load = () => linkedToMe().then(setLinked).catch((err) => setError(errorText(err)));
  useEffect(() => {
    load();
  }, []);

  async function unlink(which) {
    setError(null);
    try {
      if (which === 'all') await unlinkAll();
      else await unlinkImportedAuthor(which.id);
    } catch (err) {
      setError(errorText(err, t('settings.importedMessages.failed')));
    }
    load();
  }

  return (
    <div className="settings-card">
      <h5>{t('settings.importedMessages.title')}</h5>
      <p className="vc-hint">{t('settings.importedMessages.hint')}</p>
      {linked && linked.length === 0 && <p className="vc-hint">{t('settings.importedMessages.none')}</p>}
      {linked && linked.length > 0 && (
        <>
          <ul className="imported-links">
            {linked.map((row) => (
              <li key={row.id} className="imported-link">
                <span>
                  <strong>{row.guild_name}</strong>
                  <span className="vc-hint">
                    {' · '}{t('settings.importedMessages.as', { name: row.name })}
                    {' · '}{t('settings.importedMessages.count', { count: row.message_count })}
                  </span>
                </span>
                <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={() => setConfirming(row)}>
                  {t('settings.importedMessages.unlink')}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={() => setConfirming('all')}>
            {t('settings.importedMessages.unlinkAll')}
          </button>
        </>
      )}
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.importOptOut}
          onChange={(e) => setPreference('importOptOut', e.target.checked).catch((err) => setError(errorText(err, t('settings.savingFailed'))))}
        />
        {' '}{t('settings.importedMessages.optOut')}
      </label>
      <p className="vc-hint">{t('settings.importedMessages.optOutHint')}</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {confirming && (
        <ConfirmDialog
          title={t('settings.importedMessages.confirmTitle')}
          message={confirming === 'all'
            ? t('settings.importedMessages.confirmAll')
            : t('settings.importedMessages.confirmOne', { name: confirming.name, guild: confirming.guild_name })}
          confirmLabel={t('settings.importedMessages.unlink')}
          onConfirm={() => unlink(confirming)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
