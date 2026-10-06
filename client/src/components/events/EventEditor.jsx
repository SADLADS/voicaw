import React, { useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faImage, faLocationDot, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/events.css';
import Modal from '../guild/Modal';
import EventCard from './EventCard';
import DocumentCover from '../documents/DocumentCover';
import { createEvent, moveOccurrence, updateEvent } from '../../services/guildService';
import { uploadAttachment } from '../../services/attachmentUpload';
import { seedAttachmentCache } from '../../services/attachmentCache';
import { readMediaDimensions } from '../../utils/mediaDimensions';
import { eventVoiceChannels, fromInputs, toInputs } from '../../utils/eventDisplay';
import { deviceTimeZone, repeatChoices, repeatKey, ruleFor } from '../../utils/eventRecurrence';
import { defaultStart } from '../../utils/eventCalendar';
import { errorMessage } from '../../utils/guildDisplay';
import { PERMISSIONS, has } from '../../utils/permissions';
import { t } from '../../i18n';

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;
const MAX_LOCATION = 100;
const STEPS = ['where', 'info', 'review'];

// An image file, uploaded like a message attachment; its URL is the cover (as a document's).
async function uploadCover(file) {
  const objectUrl = URL.createObjectURL(file);
  const dimensions = await readMediaDimensions(file, objectUrl).catch(() => null);
  const url = await uploadAttachment(file, null, dimensions);
  seedAttachmentCache(url, objectUrl);
  return url;
}

// Moving only the next occurrence of a repeating event: its start and end.
function OccurrenceEditor({ event, onSaved, onClose }) {
  const start = toInputs(event.start_time);
  const end = toInputs(event.end_time);
  const [startDate, setStartDate] = useState(start.date);
  const [startTime, setStartTime] = useState(start.time);
  const [endDate, setEndDate] = useState(end.date);
  const [endTime, setEndTime] = useState(end.time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    const startAt = fromInputs(startDate, startTime);
    const endAt = fromInputs(endDate, endTime);
    if (startAt == null) return setError(t('events.editor.errors.start'));
    setBusy(true);
    setError(null);
    try {
      onSaved(await moveOccurrence(event.id, { startTime: startAt, ...(endAt != null ? { endTime: endAt } : {}) }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('events.editor.occurrenceTitle')}
      className="event-editor"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="event-occurrence-form" className="btn btn-primary btn-sm vc-button" disabled={busy}>{t('common.save')}</button>
        </>
      )}
    >
      <form id="event-occurrence-form" className="vc-form" onSubmit={save}>
        <p className="vc-hint">{t('events.editor.occurrenceHint')}</p>
        <TimeInputs
          label={t('events.editor.start')}
          idPrefix="occurrence-start"
          date={startDate}
          time={startTime}
          onDate={setStartDate}
          onTime={setStartTime}
        />
        {event.end_time != null && (
          <TimeInputs
            label={t('events.editor.end')}
            idPrefix="occurrence-end"
            date={endDate}
            time={endTime}
            onDate={setEndDate}
            onTime={setEndTime}
          />
        )}
      </form>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}

// A date and a time, side by side.
function TimeInputs({ label, idPrefix, date, time, onDate, onTime, hint = null }) {
  return (
    <div className="event-editor-time">
      <label className="event-editor-label" htmlFor={`${idPrefix}-date`}>{label}</label>
      <div className="event-editor-time-inputs">
        <input id={`${idPrefix}-date`} type="date" className="form-control" aria-label={t('events.editor.dateOf', { what: label })} value={date} onChange={(e) => onDate(e.target.value)} />
        <input id={`${idPrefix}-time`} type="time" className="form-control" aria-label={t('events.editor.timeOf', { what: label })} value={time} onChange={(e) => onTime(e.target.value)} />
      </div>
      {hint && <p className="vc-hint">{hint}</p>}
    </div>
  );
}

// Making or editing an event, in Discord's three steps: where (a voice channel you may hold
// one in, or somewhere else), what and when (name, start, end, how it repeats, description,
// cover), then a look at the card before saving. With `occurrence`, only the next occurrence of
// a repeating event moves (OccurrenceEditor). A new event starts at `start` (unix s; a day
// picked on the calendar) or the next whole hour.
export default function EventEditor({ guild, event = null, occurrence = false, start = null, onSaved, onClose }) {
  const editing = Boolean(event);
  const voiceChannels = useMemo(() => eventVoiceChannels(guild), [guild]);
  const canExternal = has(guild.my_permissions, PERMISSIONS.CREATE_EVENTS) || (editing && event.entity_type === 'external');
  const initialStart = toInputs(event?.start_time ?? start ?? defaultStart());
  const initialEnd = toInputs(event?.end_time ?? null);

  const [step, setStep] = useState('where');
  const [entityType, setEntityType] = useState(event?.entity_type ?? (voiceChannels.length ? 'voice' : 'external'));
  const [channelId, setChannelId] = useState(event?.channel_id ?? voiceChannels[0]?.id ?? null);
  const [location, setLocation] = useState(event?.location ?? '');
  const [name, setName] = useState(event?.name ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [startDate, setStartDate] = useState(initialStart.date);
  const [startTime, setStartTime] = useState(initialStart.time);
  const [endDate, setEndDate] = useState(initialEnd.date);
  const [endTime, setEndTime] = useState(initialEnd.time);
  const [repeat, setRepeat] = useState(repeatKey(event?.recurrence));
  const [image, setImage] = useState(event?.image ?? null);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const startAt = fromInputs(startDate, startTime);
  const endAt = fromInputs(endDate, endTime);
  const startDay = startAt != null ? new Date(startAt * 1000) : null;
  const choices = startDay ? repeatChoices(startDay) : [];
  // A rule the editor can't make (a bot's) stays as it is unless another is picked.
  const rule = repeat === 'custom' ? event?.recurrence : startDay ? ruleFor(repeat, startDay) : null;
  const started = event?.status === 'active';

  if (occurrence && event) return <OccurrenceEditor event={event} onSaved={onSaved} onClose={onClose} />;

  // What's wrong with the step, if anything.
  function problem(at) {
    if (at === 'where') {
      if (entityType === 'voice' && channelId == null) return t('events.editor.errors.channel');
      if (entityType === 'external' && !location.trim()) return t('events.editor.errors.location');
    }
    if (at === 'info') {
      if (!name.trim()) return t('events.editor.errors.name');
      if (startAt == null) return t('events.editor.errors.start');
      if (!started && startAt * 1000 <= Date.now()) return t('events.editor.errors.past');
      if (entityType === 'external' && endAt == null) return t('events.editor.errors.endNeeded');
      if (endAt != null && endAt <= startAt) return t('events.editor.errors.endBefore');
      if (repeat !== 'none' && !rule) return t('events.editor.errors.repeat');
    }
    return null;
  }

  function goTo(next) {
    const index = STEPS.indexOf(next);
    for (const earlier of STEPS.slice(0, index)) {
      const found = problem(earlier);
      if (found) {
        setStep(earlier);
        setError(found);
        return;
      }
    }
    setError(null);
    setStep(next);
  }

  function changeStartDate(value) {
    setStartDate(value);
    // Weekdays only can't start on a weekend: back to not repeating.
    const day = fromInputs(value, startTime);
    if (day != null && repeat !== 'none' && repeat !== 'custom' && !ruleFor(repeat, new Date(day * 1000))) setRepeat('none');
  }

  async function pickImage(file) {
    if (!file?.type.startsWith('image/')) return;
    setUploading((n) => n + 1);
    setError(null);
    try {
      setImage(await uploadCover(file));
    } catch (err) {
      setError(t('events.editor.coverFailed', { error: errorMessage(err) }));
    } finally {
      setUploading((n) => n - 1);
    }
  }

  const fields = {
    name: name.trim(),
    description: description.trim() ? description : null,
    entityType,
    channelId: entityType === 'voice' ? channelId : null,
    location: entityType === 'external' ? location.trim() : null,
    startTime: startAt,
    endTime: endAt,
    image,
    recurrence: rule ?? null,
    timezone: rule ? (repeat === 'custom' ? event.timezone : deviceTimeZone()) : null,
  };
  const preview = {
    id: event?.id ?? 0,
    name: fields.name || t('events.editor.untitled'),
    description: fields.description,
    entity_type: entityType,
    channel_id: fields.channelId,
    location: fields.location,
    start_time: startAt ?? 0,
    end_time: endAt,
    status: event?.status ?? 'scheduled',
    image,
    recurrence: fields.recurrence,
    user_count: event?.user_count ?? 1,
  };

  async function save() {
    const found = problem('where') ?? problem('info');
    if (found) return setError(found);
    setBusy(true);
    setError(null);
    try {
      onSaved(editing ? await updateEvent(event.id, fields) : await createEvent(guild.id, fields));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const index = STEPS.indexOf(step);
  return (
    <Modal
      title={editing ? t('events.editor.editTitle') : t('events.editor.createTitle')}
      className="event-editor"
      onClose={onClose}
      actions={(
        <>
          {index > 0
            ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setError(null); setStep(STEPS[index - 1]); }}>{t('events.editor.back')}</button>
            : <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>}
          {step !== 'review' ? (
            <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => goTo(STEPS[index + 1])} disabled={uploading > 0}>{t('events.editor.next')}</button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm vc-button" onClick={save} disabled={busy || uploading > 0}>
              {editing ? t('common.save') : t('events.editor.create')}
            </button>
          )}
        </>
      )}
    >
      <ol className="event-editor-steps" aria-label={t('events.editor.steps')}>
        {STEPS.map((s, i) => (
          <li key={s} className={`${s === step ? 'current' : ''}${i < index ? ' done' : ''}`} aria-current={s === step ? 'step' : undefined}>
            {t(`events.editor.step.${s}`)}
          </li>
        ))}
      </ol>

      {step === 'where' && (
        <div className="vc-form">
          <p className="event-editor-question">{t('events.editor.whereQuestion')}</p>
          <fieldset className="event-place-choice">
            <legend className="event-visually-hidden">{t('events.editor.whereQuestion')}</legend>
            <label className={`event-place-option${entityType === 'voice' ? ' selected' : ''}${voiceChannels.length ? '' : ' disabled'}`}>
              <input type="radio" name="event-place" value="voice" checked={entityType === 'voice'} disabled={!voiceChannels.length} onChange={() => setEntityType('voice')} />
              <FontAwesomeIcon icon={faVolumeHigh} />
              <span>
                <strong>{t('events.editor.voice')}</strong>
                <span className="vc-hint">{voiceChannels.length ? t('events.editor.voiceHint') : t('events.editor.noVoiceChannels')}</span>
              </span>
            </label>
            <label className={`event-place-option${entityType === 'external' ? ' selected' : ''}${canExternal ? '' : ' disabled'}`}>
              <input type="radio" name="event-place" value="external" checked={entityType === 'external'} disabled={!canExternal} onChange={() => setEntityType('external')} />
              <FontAwesomeIcon icon={faLocationDot} />
              <span>
                <strong>{t('events.editor.external')}</strong>
                <span className="vc-hint">{t('events.editor.externalHint')}</span>
              </span>
            </label>
          </fieldset>
          {entityType === 'voice' ? (
            <>
              <label htmlFor="event-channel">{t('events.editor.channel')}</label>
              <select id="event-channel" className="form-select form-control" value={channelId ?? ''} onChange={(e) => setChannelId(Number(e.target.value))}>
                {voiceChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="event-location">{t('events.editor.location')}</label>
              <input
                id="event-location"
                className="form-control"
                maxLength={MAX_LOCATION}
                placeholder={t('events.editor.locationPlaceholder')}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                autoFocus
              />
            </>
          )}
        </div>
      )}

      {step === 'info' && (
        <div className="vc-form">
          <label htmlFor="event-name">{t('events.editor.name')}</label>
          <input
            id="event-name"
            className="form-control"
            maxLength={MAX_NAME}
            placeholder={t('events.editor.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <TimeInputs
            label={t('events.editor.start')}
            idPrefix="event-start"
            date={startDate}
            time={startTime}
            onDate={changeStartDate}
            onTime={setStartTime}
            hint={started ? t('events.editor.startedHint') : null}
          />
          <TimeInputs
            label={entityType === 'voice' ? t('events.editor.endOptional') : t('events.editor.end')}
            idPrefix="event-end"
            date={endDate}
            time={endTime}
            onDate={setEndDate}
            onTime={setEndTime}
          />
          <label htmlFor="event-repeat">{t('events.editor.repeat')}</label>
          <select id="event-repeat" className="form-select form-control" value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={!startDay}>
            {repeat === 'custom' && <option value="custom">{t('events.repeat.custom')}</option>}
            {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          {rule && <p className="vc-hint">{t('events.editor.repeatHint')}</p>}
          <label htmlFor="event-description">{t('events.editor.description')}</label>
          <textarea
            id="event-description"
            className="form-control"
            rows={4}
            maxLength={MAX_DESCRIPTION}
            placeholder={t('events.editor.descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="event-editor-label">{t('events.editor.cover')}</span>
          <input ref={fileRef} type="file" accept="image/*" hidden aria-label={t('events.editor.coverFile')} onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
          {image ? (
            <div className="event-editor-cover">
              <DocumentCover cover={image} className="event-card-cover" />
              <div className="event-editor-cover-buttons">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading > 0}>{t('events.editor.changeCover')}</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setImage(null)}>{t('events.editor.removeCover')}</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm event-editor-add-cover" onClick={() => fileRef.current?.click()} disabled={uploading > 0}>
              <FontAwesomeIcon icon={faImage} /> {uploading ? t('events.editor.uploading') : t('events.editor.addCover')}
            </button>
          )}
        </div>
      )}

      {step === 'review' && (
        <div className="event-editor-review">
          <p className="vc-hint">{t('events.editor.reviewHint')}</p>
          <EventCard event={preview} guild={guild} />
        </div>
      )}

      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
