import React from 'react';
import {
  FRAME_RATES, RESOLUTIONS, cleanStreamLimit, clampStream, frameRateAllowed, resolutionAllowed, setStreamSettings, useStreamSettings,
} from '../../voice/streamSettings';
import { t } from '../../i18n';

function Choices({ label, options, value, allowed, onPick, name }) {
  return (
    <fieldset className="stream-quality-field">
      <legend>{label}</legend>
      <div className="stream-quality-options" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            className={`stream-quality-option${option === value ? ' selected' : ''}`}
            disabled={!allowed(option)}
            onClick={() => onPick(option)}
          >
            {name(option)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// Screen share quality, as Discord's: resolution and frame rate (voice/streamSettings.js),
// remembered on this device. With `limit` (the server's cap, known while in voice), choices
// above it are greyed out and the chosen one shows as what will really go out.
export default function StreamQualityPicker({ limit = null }) {
  const saved = useStreamSettings();
  const { resolution, frameRate } = clampStream(saved, limit);
  const cap = cleanStreamLimit(limit);
  const capped = cap.resolution !== 'source' || cap.frameRate !== 60;
  return (
    <div className="stream-quality">
      <Choices
        label={t('voice.streamQuality.resolution')}
        options={RESOLUTIONS}
        value={resolution}
        allowed={(r) => resolutionAllowed(r, limit)}
        onPick={(r) => setStreamSettings({ resolution: r })}
        name={(r) => t(`voice.streamQuality.resolutions.${r}`)}
      />
      <Choices
        label={t('voice.streamQuality.frameRate')}
        options={FRAME_RATES}
        value={frameRate}
        allowed={(f) => frameRateAllowed(f, limit)}
        onPick={(f) => setStreamSettings({ frameRate: f })}
        name={(f) => t('voice.streamQuality.fps', { fps: f })}
      />
      {limit && capped && (
        <p className="vc-hint">
          {t('voice.streamQuality.limited', {
            resolution: t(`voice.streamQuality.resolutions.${cap.resolution}`),
            fps: cap.frameRate,
          })}
        </p>
      )}
    </div>
  );
}
