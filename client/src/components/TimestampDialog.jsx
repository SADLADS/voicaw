import React, { useState } from 'react';
import Modal from './guild/Modal';
import { fromInputs, toInputs } from '../utils/eventDisplay';
import { useDateFormat } from '../utils/dateFormat';
import { DEFAULT_TIMESTAMP_STYLE, TIMESTAMP_STYLES, timestampText, useTimestampText } from '../utils/timestamps';
import { t } from '../i18n';

// One format to choose: how the time reads in it (a relative one counting), and its name.
function StyleChoice({ unix, style, checked, onChoose }) {
  const preview = useTimestampText(unix ?? 0, style);
  return (
    <label className={`timestamp-style${checked ? ' checked' : ''}`}>
      <input type="radio" name="timestamp-style" value={style} checked={checked} onChange={onChoose} />
      <span className="timestamp-style-text">
        <span className="timestamp-style-preview">{unix == null ? '—' : preview}</span>
        <span className="timestamp-style-name">{t(`chat.timestampDialog.styles.${style}`)}</span>
      </span>
    </label>
  );
}

// The + menu's Timestamps: a date and time (the next full hour to start with) and how it
// reads (Discord's formats), put in the message box as `<t:unix:style>` (utils/timestamps).
// Everyone reading the message sees it in their own time zone.
// `onInsert({ unix, style })` puts it in the message.
export default function TimestampDialog({ onInsert, onClose }) {
  useDateFormat();
  const [inputs, setInputs] = useState(() => toInputs(Math.ceil(Date.now() / 3600000) * 3600));
  const [style, setStyle] = useState(DEFAULT_TIMESTAMP_STYLE);
  const unix = fromInputs(inputs.date, inputs.time);

  function insert(e) {
    e.preventDefault();
    if (unix == null) return;
    onInsert({ unix, style });
    onClose();
  }

  return (
    <Modal
      title={t('chat.timestampDialog.title')}
      className="timestamp-dialog"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="timestamp-form" className="btn btn-primary btn-sm vc-button" disabled={unix == null}>
            {t('chat.timestampDialog.insert')}
          </button>
        </>
      )}
    >
      <form id="timestamp-form" className="vc-form" onSubmit={insert}>
        <p className="vc-hint">{t('chat.timestampDialog.intro')}</p>
        <div className="timestamp-dialog-when">
          <input
            type="date"
            className="form-control"
            aria-label={t('chat.timestampDialog.date')}
            value={inputs.date}
            onChange={(e) => setInputs((v) => ({ ...v, date: e.target.value }))}
            autoFocus
          />
          <input
            type="time"
            className="form-control"
            aria-label={t('chat.timestampDialog.time')}
            value={inputs.time}
            onChange={(e) => setInputs((v) => ({ ...v, time: e.target.value }))}
          />
        </div>
        <fieldset className="timestamp-styles">
          <legend>{t('chat.timestampDialog.format')}</legend>
          {TIMESTAMP_STYLES.map((s) => (
            <StyleChoice key={s} unix={unix} style={s} checked={style === s} onChoose={() => setStyle(s)} />
          ))}
        </fieldset>
        {unix != null && (
          <p className="vc-hint timestamp-dialog-code">
            {t('chat.timestampDialog.code')} <code>{timestampText(unix, style)}</code>
          </p>
        )}
      </form>
    </Modal>
  );
}
