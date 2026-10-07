import React from 'react';
import Modal from '../guild/Modal';
import { useVoice } from '../../hooks/useVoice';
import { startScreenShare } from '../../voice/voiceClient';
import StreamQualityPicker from './StreamQualityPicker';
import { t } from '../../i18n';

// A browser's step before its own screen picker: the stream's quality, then Go Live (a click,
// which the browser needs to ask what to share). The desktop app's ScreenPicker has the same
// choices beside its screens.
export default function GoLiveDialog({ onClose }) {
  const voice = useVoice();
  const goLive = () => {
    onClose();
    startScreenShare();
  };
  return (
    <Modal
      title={t('voice.screenPicker.title')}
      onClose={onClose}
      className="go-live-dialog"
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary btn-sm vc-button" onClick={goLive}>
            {t('voice.screenPicker.goLive')}
          </button>
        </>
      )}
    >
      <StreamQualityPicker limit={voice.streamLimit} />
      <p className="vc-hint">{t('voice.streamQuality.browserAsks')}</p>
    </Modal>
  );
}
