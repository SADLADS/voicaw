import React, { useEffect, useState } from 'react';
import { acceleratorFromEvent, describeAccelerator, desktop } from '../utils/desktop';
import { t } from '../i18n';

const SHORTCUTS = [
  { action: 'toggleMute', labelKey: 'settings.desktopApp.toggleMute', shortcutKey: 'settings.desktopApp.toggleMuteShortcut' },
  { action: 'toggleDeafen', labelKey: 'settings.desktopApp.toggleDeafen', shortcutKey: 'settings.desktopApp.toggleDeafenShortcut' },
  {
    action: 'toggleOverlay',
    labelKey: 'settings.desktopApp.toggleOverlay',
    shortcutKey: 'settings.desktopApp.toggleOverlayShortcut',
    hintKey: 'settings.desktopApp.toggleOverlayHint',
  },
];
const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// Settings → Desktop App (only in the desktop app): closing to the tray, starting at login,
// updating automatically (electron/updater.js), sharing what you're playing (Rich Presence, electron/richPresence.js), the in-game overlay
// (electron/overlay.js: on/off and its corner) and global shortcuts (mute, deafen, the overlay's). Kept by the app itself (electron/desktopSettings.js).
export default function DesktopAppSettings() {
  const [settings, setSettings] = useState(null);
  const [recording, setRecording] = useState(null); // the action whose key is being set
  const [failed, setFailed] = useState([]);

  useEffect(() => {
    desktop.getSettings().then(setSettings).catch((err) => console.error('Could not load desktop settings', err));
  }, []);

  async function save(changes) {
    const result = await desktop.updateSettings(changes);
    if (!result) return;
    setSettings(result.settings);
    setFailed(result.failedShortcuts);
  }

  // Recording: the next key press with a modifier (or a function key) is the shortcut;
  // Escape cancels, Backspace/Delete clears it.
  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecording(null);
        save({ shortcuts: { [recording]: null } });
        return;
      }
      const accelerator = acceleratorFromEvent(e);
      if (!accelerator) return;
      setRecording(null);
      save({ shortcuts: { [recording]: accelerator } });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording]);

  if (!settings) return null;
  return (
    <div className="settings-card">
      <h5 id="settings-desktop-app">{t('settings.desktopApp.title')}</h5>
      <label className="settings-toggle">
        <input type="checkbox" checked={settings.closeToTray} onChange={(e) => save({ closeToTray: e.target.checked })} />
        {' '}{t('settings.desktopApp.closeToTray')}
      </label>
      <p className="vc-hint">{t('settings.desktopApp.closeToTrayHint')}</p>
      <label className="settings-toggle">
        <input type="checkbox" checked={settings.startAtLogin} onChange={(e) => save({ startAtLogin: e.target.checked })} />
        {' '}{t('settings.desktopApp.startAtLogin')}
      </label>
      <p className="vc-hint">{t('settings.desktopApp.startAtLoginHint')}</p>
      <label className="settings-toggle">
        <input type="checkbox" checked={settings.autoUpdate !== false} onChange={(e) => save({ autoUpdate: e.target.checked })} />
        {' '}{t('settings.desktopApp.autoUpdate')}
      </label>
      <p className="vc-hint">{t('settings.desktopApp.autoUpdateHint')}</p>

      <h6 id="settings-activity" className="desktop-shortcuts-title">{t('settings.desktopApp.activity')}</h6>
      <label className="settings-toggle">
        <input type="checkbox" checked={settings.richPresence !== false} onChange={(e) => save({ richPresence: e.target.checked })} />
        {' '}{t('settings.desktopApp.shareActivity')}
      </label>
      <p className="vc-hint">{t('settings.desktopApp.shareActivityHint')}</p>

      {'overlay' in settings && (
        <>
          <h6 id="settings-overlay" className="desktop-shortcuts-title">{t('settings.desktopApp.overlay')}</h6>
          <label className="settings-toggle">
            <input type="checkbox" checked={settings.overlay !== false} onChange={(e) => save({ overlay: e.target.checked })} />
            {' '}{t('settings.desktopApp.overlayOn')}
          </label>
          <p className="vc-hint">{t('settings.desktopApp.overlayHint')}</p>
          {settings.overlay !== false && (
            <label className="desktop-overlay-position">
              <span>{t('settings.desktopApp.overlayPosition')}</span>
              <select value={settings.overlayPosition ?? 'top-left'} onChange={(e) => save({ overlayPosition: e.target.value })}>
                {OVERLAY_POSITIONS.map((p) => <option key={p} value={p}>{t(`settings.desktopApp.overlayPositions.${p}`)}</option>)}
              </select>
            </label>
          )}
        </>
      )}

      <h6 id="settings-shortcuts" className="desktop-shortcuts-title">{t('settings.desktopApp.shortcuts')}</h6>
      <p className="vc-hint">{t('settings.desktopApp.shortcutsHint')}</p>
      <div className="desktop-shortcuts">
        {SHORTCUTS.filter(({ action }) => action in settings.shortcuts).map(({ action, labelKey, shortcutKey, hintKey }) => {
          const accelerator = settings.shortcuts[action];
          const isRecording = recording === action;
          return (
            <div key={action} className="desktop-shortcut">
              <span className="desktop-shortcut-label">{t(labelKey)}</span>
              <button
                type="button"
                className={`btn btn-sm btn-secondary desktop-shortcut-key${isRecording ? ' recording' : ''}`}
                aria-label={t(shortcutKey)}
                onClick={() => setRecording(isRecording ? null : action)}
              >
                {isRecording ? t('settings.desktopApp.pressKey') : accelerator ? describeAccelerator(accelerator) : t('settings.desktopApp.notSet')}
              </button>
              {accelerator && !isRecording && (
                <button type="button" className="link-button" onClick={() => save({ shortcuts: { [action]: null } })}>
                  {t('settings.desktopApp.clear')}
                </button>
              )}
              {failed.includes(action) && (
                <span className="error-msg desktop-shortcut-error" role="alert">{t('settings.desktopApp.shortcutTaken')}</span>
              )}
              {hintKey && <p className="vc-hint desktop-shortcut-hint">{t(hintKey)}</p>}
            </div>
          );
        })}
      </div>
      {recording && <p className="vc-hint">{t('settings.desktopApp.recordingHint')}</p>}
    </div>
  );
}
