import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay } from '@fortawesome/free-solid-svg-icons';
import { SOUNDS, SOUND_NAMES } from '../sounds/soundList';
import { playSound, setSoundEnabled, setSoundVolume, useSoundPrefs } from '../sounds/sounds';
import { t } from '../i18n';

// Settings → Sounds: the app's sound effects (sounds/), on this device: a volume, and each
// sound on or off, with a button to hear it.
export default function SoundSettings() {
  const { volume, off } = useSoundPrefs();
  return (
    <div className="settings-card sound-settings">
      <h5>{t('settings.sounds.title')}</h5>
      <label className="sound-volume">
        {t('settings.sounds.volume')}
        <input
          type="range" min="0" max="100" step="1"
          aria-label={t('settings.sounds.volumeLabel')}
          value={Math.round(volume * 100)}
          onChange={(e) => setSoundVolume(Number(e.target.value) / 100)}
          onPointerUp={() => playSound('message', { preview: true })}
          onKeyUp={() => playSound('message', { preview: true })}
        />
        <span className="sound-volume-value">{Math.round(volume * 100)}%</span>
      </label>
      <ul className="sound-list">
        {SOUND_NAMES.map((name) => {
          const sound = SOUNDS[name];
          const label = t(sound.labelKey);
          return (
            <li key={name}>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={!off.includes(name)}
                  onChange={(e) => setSoundEnabled(name, e.target.checked)}
                />
                <span>
                  {label}
                  {sound.descriptionKey && <span className="vc-hint sound-description">{t(sound.descriptionKey)}</span>}
                </span>
              </label>
              <button
                type="button" className="sound-preview"
                aria-label={t('settings.sounds.playSound', { sound: label })} title={t('settings.sounds.play')}
                onClick={() => playSound(name, { preview: true })}
              >
                <FontAwesomeIcon icon={faPlay} />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="vc-hint">{t('settings.savedOnDevice')}</p>
    </div>
  );
}
