import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../guild/Modal';
import { desktop } from '../../utils/desktop';
import { useVoice } from '../../hooks/useVoice';
import { startScreenShare } from '../../voice/voiceClient';
import StreamQualityPicker from './StreamQualityPicker';
import { t } from '../../i18n';

const REFRESH_MS = 4000;

// Games (Windows: game capture, electron/gameCapture.js) as picker entries: shared through
// their window's source, then captured from inside the game (voiceClient startScreenShare).
const gameEntries = (games) => (games ?? []).map((game) => ({
  id: `game:${game.hwnd}`, kind: 'game', name: game.name, thumbnail: game.thumbnail, icon: game.icon, hwnd: game.hwnd, sourceId: game.sourceId,
}));

// The desktop app's screen picker (a browser has its own): the games you're running (Windows),
// your screens and windows with live-ish thumbnails, the stream's quality, and, where the system
// can (Windows; Linux with PipeWire), whether to share its sound. Go Live tells the app which
// one (electron/screenShare.js), then starts sharing as usual.
export default function ScreenPicker({ onClose }) {
  const voice = useVoice();
  const [tab, setTab] = useState('screen');
  const [sources, setSources] = useState(null);
  const [canShareSound, setCanShareSound] = useState(false);
  const [soundFrom, setSoundFrom] = useState(null);
  const [selected, setSelected] = useState(null);
  const [audio, setAudio] = useState(true);
  const [listError, setListError] = useState(null);
  const [pickError, setPickError] = useState(null);
  const tabChosen = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await desktop.getScreenSources();
      if (!result) return;
      const games = gameEntries(result.games);
      setSources([...games, ...result.sources]);
      setCanShareSound(result.canShareSound);
      setSoundFrom(result.soundFrom ?? null);
      setListError(null);
      // A game running: start on it. With only windows to show (no screens listed), there.
      if (!tabChosen.current) {
        if (games.length > 0) setTab('game');
        else if (!result.sources.some((s) => s.kind === 'screen')) setTab('window');
        else setTab('screen');
      }
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

  const hasGames = (sources ?? []).some((s) => s.kind === 'game');

  const goLive = async (source = chosen) => {
    if (!source) return;
    const game = source.kind === 'game' ? { hwnd: source.hwnd } : null;
    const ok = await desktop.chooseScreenSource(game ? source.sourceId : source.id, audio && canShareSound);
    if (!ok) {
      setPickError(t('voice.screenPicker.gone'));
      setSelected(null);
      load();
      return;
    }
    onClose();
    startScreenShare({ audio: audio && canShareSound, deviceSound: soundFrom === 'device', game });
  };

  const tabs = [
    ...(hasGames || tab === 'game' ? [['game', t('voice.screenPicker.games')]] : []),
    ['screen', t('voice.screenPicker.screens')],
    ['window', t('voice.screenPicker.windows')],
  ];
  const tabLabel = tabs.find(([key]) => key === tab)?.[1];
  const emptyText = tab === 'game' ? t('voice.screenPicker.noGames') : tab === 'screen' ? t('voice.screenPicker.noScreens') : t('voice.screenPicker.noWindows');

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
        {tabs.map(([key, label]) => (
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
        <p className="vc-hint">{emptyText}</p>
      ) : (
        <ul className="screen-picker-grid" role="listbox" aria-label={tabLabel}>
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
      {tab === 'game' && <p className="vc-hint screen-picker-note">{t('voice.screenPicker.gamesNote')}</p>}
      <StreamQualityPicker limit={voice.streamLimit} />
      {desktop?.platform === 'darwin' && (
        <p className="vc-hint screen-picker-note">
          {t('voice.screenPicker.macNote')}
        </p>
      )}
    </Modal>
  );
}
