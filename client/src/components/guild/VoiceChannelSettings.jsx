import React, { useEffect, useState } from 'react';
import { fetchVoiceRegions } from '../../services/voiceService';
import { t } from '../../i18n';

const MIN_BITRATE = 8000;
const MAX_BITRATE = 384000;
const MAX_USER_LIMIT = 99;

// A voice channel's own settings in its Overview (ChannelDialog), like Discord's: the bitrate
// its microphones go out at, how many people can be in it, and its voice region (shown only
// when there's more than one; server/voiceRegions.js). `value` is { bitrate, userLimit,
// rtcRegion }, `onChange` gets the whole of it changed.
export default function VoiceChannelSettings({ value, onChange }) {
  const [regions, setRegions] = useState([]);
  useEffect(() => {
    let live = true;
    fetchVoiceRegions().then((list) => { if (live) setRegions(list); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const set = (changes) => onChange({ ...value, ...changes });
  const kbps = Math.round(value.bitrate / 1000);
  const fallback = regions.find((r) => r.default);
  const regionName = (r) => (r.flag ? `${r.flag} ${r.name}` : r.name);

  return (
    <div className="voice-channel-settings">
      <label className="voice-settings-field" htmlFor="channel-bitrate">
        <span>{t('guildAdmin.channelDialog.voice.bitrate')}</span>
        <span className="sound-volume">
          <input
            id="channel-bitrate"
            type="range" min={MIN_BITRATE / 1000} max={MAX_BITRATE / 1000} step="1"
            value={kbps}
            onChange={(e) => set({ bitrate: Number(e.target.value) * 1000 })}
          />
          <span className="sound-volume-value">{t('guildAdmin.channelDialog.voice.kbps', { kbps })}</span>
        </span>
      </label>
      <p className="vc-hint">
        {kbps > 96 ? t('guildAdmin.channelDialog.voice.bitrateHighHint') : t('guildAdmin.channelDialog.voice.bitrateHint')}
      </p>

      <label className="voice-settings-field" htmlFor="channel-user-limit">
        <span>{t('guildAdmin.channelDialog.voice.userLimit')}</span>
        <span className="sound-volume">
          <input
            id="channel-user-limit"
            type="range" min="0" max={MAX_USER_LIMIT} step="1"
            value={value.userLimit}
            onChange={(e) => set({ userLimit: Number(e.target.value) })}
          />
          <span className="sound-volume-value">
            {value.userLimit === 0 ? t('guildAdmin.channelDialog.voice.noLimit') : t('guildAdmin.channelDialog.voice.users', { count: value.userLimit })}
          </span>
        </span>
      </label>
      <p className="vc-hint">{t('guildAdmin.channelDialog.voice.userLimitHint')}</p>

      {regions.length > 1 && (
        <>
          <label htmlFor="channel-region">{t('guildAdmin.channelDialog.voice.region')}</label>
          <select
            id="channel-region"
            className="form-select form-control"
            value={value.rtcRegion ?? ''}
            onChange={(e) => set({ rtcRegion: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">
              {fallback ? t('guildAdmin.channelDialog.voice.automaticIs', { region: regionName(fallback) }) : t('guildAdmin.channelDialog.voice.automatic')}
            </option>
            {regions.map((r) => <option key={r.id} value={r.id}>{regionName(r)}</option>)}
          </select>
          <p className="vc-hint">{t('guildAdmin.channelDialog.voice.regionHint')}</p>
        </>
      )}
    </div>
  );
}
