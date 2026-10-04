import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../guild/Modal';
import { desktop } from '../../utils/desktop';
import { startScreenShare } from '../../voice/voiceClient';
import { t } from '../../i18n';

const REFRESH_MS = 4000;

// The desktop app's screen picker (a browser has its own): your screens and windows with
// live-ish thumbnails, and, where the system can (Windows), whether to share its sound. Go
// Live tells the app which one (electron/screenShare.js), then starts sharing as usual.
export default function ScreenPicker({ onClose }) {
  const [tab, setTab] = useState('screen');
  const [sources, setSources] = useState(null);
  const [canShareSound, setCanShareSound] = useState(false);
  const [selected, setSelected] = useState(null);
  const [audio, setAudio] = useState(true);
  const [listError, setListError] = useState(null);
  const [pickError, setPickError] = useState(null);
  const tabChosen = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await desktop.getScreenSources();
      if (!result) return;
      setSources(result.sources);
      setCanShareSound(result.canShareSound);
      setListError(null);
      // With only windows to show (no screens listed), start there.
      if (!tabChosen.current && !result.sources.some((s) => s.kind === 'screen')) setTab('window');
    } catch (err) {
      console.warn('Could not list screens', err);
      setListError(t('voice.screenPicker.listError'));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const shown = (sources ?? []).filter((s) => s.kind === tab);
  const chosen = sources?.find((s) => s.id === selected) ?? null;

  const goLive = async (source = chosen) => {
    if (!source) return;
    const ok = await desktop.chooseScreenSource(source.id, audio && canShareSound);
    if (!ok) {
      setPickError(t('voice.screenPicker.gone'));
      setSelected(null);
      load();
      return;
    }
    onClose();
    startScreenShare({ audio: audio && canShareSound });
  };

  const pickTab = (next) => {
    tabChosen.current = true;
    setTab(next);
  };

  return (
    <Modal
      title={t('voice.screenPicker.title')}
      onClose={onClose}
      className="screen-picker"
      actions={(
        <>
          {canShareSound && (
            <label className="screen-picker-sound me-auto">
              <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
              <span>{t('voice.screenPicker.shareSound')}</span>
            </label>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary btn-sm vc-button" disabled={!chosen} onClick={() => goLive()}>
            {t('voice.screenPicker.goLive')}
          </button>
        </>
      )}
    >
      <div className="settings-tabs" role="tablist">
        {[['screen', t('voice.screenPicker.screens')], ['window', t('voice.screenPicker.windows')]].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`settings-tab${tab === key ? ' active' : ''}`}
            onClick={() => pickTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {(pickError || listError) && <p className="error-text">{pickError || listError}</p>}
      {sources === null ? (
        <p className="vc-hint">{t('voice.screenPicker.looking')}</p>
      ) : shown.length === 0 ? (
        <p className="vc-hint">{tab === 'screen' ? t('voice.screenPicker.noScreens') : t('voice.screenPicker.noWindows')}</p>
      ) : (
        <ul className="screen-picker-grid" role="listbox" aria-label={tab === 'screen' ? t('voice.screenPicker.screens') : t('voice.screenPicker.windows')}>
          {shown.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                role="option"
                aria-selected={source.id === selected}
                className={`screen-picker-source${source.id === selected ? ' selected' : ''}`}
                onClick={() => {
                  setSelected(source.id);
                  setPickError(null);
                }}
                onDoubleClick={() => goLive(source)}
              >
                <span className="screen-picker-thumb">
                  {source.thumbnail && <img src={source.thumbnail} alt="" />}
                </span>
                <span className="screen-picker-name">
                  {source.icon && <img src={source.icon} alt="" className="screen-picker-icon" />}
                  <span>{source.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {desktop?.platform === 'darwin' && (
        <p className="vc-hint screen-picker-note">
          {t('voice.screenPicker.macNote')}
        </p>
      )}
    </Modal>
  );
}
