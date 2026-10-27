import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import { faFaceSmile, faImage, faLocationDot, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/events.css';
import Modal from '../guild/Modal';
import EmojiPicker from '../EmojiPicker';
import EventCard from './EventCard';
import EventEmoji from './EventEmoji';
import DocumentCover from '../documents/DocumentCover';
import { createEvent, moveOccurrence, updateEvent } from '../../services/guildService';
import { uploadAttachment } from '../../services/attachmentUpload';
import { seedAttachmentCache } from '../../services/attachmentCache';
import { readMediaDimensions } from '../../utils/mediaDimensions';
import { eventVoiceChannels, formatEventWhen, fromInputs, toInputs } from '../../utils/eventDisplay';
import { deviceTimeZone, occurrenceView, repeatChoices, repeatKey, ruleFor } from '../../utils/eventRecurrence';
import { allDayInputs, allDayTimes, defaultStart } from '../../utils/eventCalendar';
import { errorMessage } from '../../utils/guildDisplay';
import { COLOR_SWATCHES, PERMISSIONS, colorToHex, has, hexToColor } from '../../utils/permissions';
import { reactionPickerPosition } from '../../utils/reactionPickerPosition';
import { t } from '../../i18n';

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;
const MAX_LOCATION = 100;
// The most an event's going may be capped at (as the server's).
const MAX_RSVP_LIMIT = 1000;
const STEPS = ['where', 'info', 'review'];

// An image file, uploaded like a message attachment; its URL is the cover (as a document's).
async function uploadCover(file) {
  const objectUrl = URL.createObjectURL(file);
  const dimensions = await readMediaDimensions(file, objectUrl).catch(() => null);
  const url = await uploadAttachment(file, null, dimensions);
  seedAttachmentCache(url, objectUrl);
  return url;
}

// One occurrence of a repeating event alone (`view`, occurrenceView's): its start and end (its
// dates, all day), and its own topic, description and place (somewhere else).
function OccurrenceEditor({ view, onSaved, onClose }) {
  const allDay = Boolean(view.all_day);
  const days = allDay ? allDayInputs(view) : null;
  const start = toInputs(view.start_time);
  const end = toInputs(view.end_time);
  const [startDate, setStartDate] = useState(days?.start ?? start.date);
  const [startTime, setStartTime] = useState(start.time);
  const [endDate, setEndDate] = useState(days?.end ?? end.date);
  const [endTime, setEndTime] = useState(end.time);
  const [name, setName] = useState(view.name ?? '');
  const [description, setDescription] = useState(view.description ?? '');
  const [location, setLocation] = useState(view.location ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const external = view.entity_type === 'external';

  async function save(e) {
    e.preventDefault();
    const whole = allDayTimes(startDate, endDate);
    const startAt = allDay ? whole.startTime : fromInputs(startDate, startTime);
    const endAt = allDay ? whole.endTime : fromInputs(endDate, endTime);
    if (startAt == null) return setError(t('events.editor.errors.start'));
    if (!name.trim()) return setError(t('events.editor.errors.name'));
    setBusy(true);
    setError(null);
    try {
      onSaved(await moveOccurrence(view.id, {
        occurrence: view.original_start,
        startTime: startAt,
        ...(endAt != null ? { endTime: endAt } : {}),
        name: name.trim(),
        description: description.trim() ? description : null,
        ...(external ? { location: location.trim() || null } : {}),
      }));
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
        <p className="vc-hint">{t('events.editor.occurrenceHint', { date: formatEventWhen(view) })}</p>
        <label htmlFor="occurrence-name">{t('events.editor.name')}</label>
        <input id="occurrence-name" className="form-control" maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} />
        <TimeInputs
          label={t('events.editor.start')}
          idPrefix="occurrence-start"
          date={startDate}
          time={startTime}
          onDate={setStartDate}
          onTime={setStartTime}
          dateOnly={allDay}
        />
        {view.end_time != null && (
          <TimeInputs
            label={t('events.editor.end')}
            idPrefix="occurrence-end"
            date={endDate}
            time={endTime}
            onDate={setEndDate}
            onTime={setEndTime}
            dateOnly={allDay}
          />
        )}
        {external && (
          <>
            <label htmlFor="occurrence-location">{t('events.editor.locationOptional')}</label>
            <input
              id="occurrence-location"
              className="form-control"
              maxLength={MAX_LOCATION}
              placeholder={t('events.editor.locationPlaceholder')}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </>
        )}
        <label htmlFor="occurrence-description">{t('events.editor.description')}</label>
        <textarea
          id="occurrence-description"
          className="form-control"
          rows={3}
          maxLength={MAX_DESCRIPTION}
          placeholder={t('events.editor.descriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </form>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}

// A date and a time, side by side (the date alone with `dateOnly`).
function TimeInputs({ label, idPrefix, date, time, onDate, onTime, hint = null, dateOnly = false }) {
  return (
    <div className="event-editor-time">
      <label className="event-editor-label" htmlFor={`${idPrefix}-date`}>{label}</label>
      <div className="event-editor-time-inputs">
        <input id={`${idPrefix}-date`} type="date" className="form-control" aria-label={t('events.editor.dateOf', { what: label })} value={date} onChange={(e) => onDate(e.target.value)} />
        {!dateOnly && (
          <input id={`${idPrefix}-time`} type="time" className="form-control" aria-label={t('events.editor.timeOf', { what: label })} value={time} onChange={(e) => onTime(e.target.value)} />
        )}
      </div>
      {hint && <p className="vc-hint">{hint}</p>}
    </div>
  );
}

// Making or editing an event, in Discord's three steps: where (a voice channel you may hold
// one in, or somewhere else, where saying where is optional), what and when (name, all day or
// not, start, end, how it repeats, description, cover, and the emoji and colour it has on the
// calendar), then a look at the card before saving. The steps along the top go to that step, as
// Next does: not past one with something missing. A repeating event (`event`) is edited as a
// whole (`scope` 'all'), from its occurrence `occurrence` (an original start) on ('following':
// the form starts from that date's, and the server makes the new event that takes over then),
// or that occurrence alone ('this': OccurrenceEditor). A new event starts at `start` (unix s; a
// day picked on the calendar) or the next whole hour.
export default function EventEditor({ guild, event: series = null, scope = 'all', occurrence = null, start = null, onSaved, onClose }) {
  const editing = Boolean(series);
  // What the form starts from: the series, or the occurrence edited.
  const event = useMemo(
    () => (series && scope !== 'all' && occurrence != null ? occurrenceView(series, occurrence) : series),
    [series, scope, occurrence],
  );
  const voiceChannels = useMemo(() => eventVoiceChannels(guild), [guild]);
  const canExternal = has(guild.my_permissions, PERMISSIONS.CREATE_EVENTS) || (editing && event.entity_type === 'external');
  const initialStart = toInputs(event?.start_time ?? start ?? defaultStart());
  const initialEnd = toInputs(event?.end_time ?? null);
  // An all-day event's dates are its maker's (allDayInputs), not this device's.
  const initialDays = event?.all_day ? allDayInputs(event) : null;

  const [step, setStep] = useState('where');
  const [entityType, setEntityType] = useState(event?.entity_type ?? (voiceChannels.length ? 'voice' : 'external'));
  const [channelId, setChannelId] = useState(event?.channel_id ?? voiceChannels[0]?.id ?? null);
  const [location, setLocation] = useState(event?.location ?? '');
  const [name, setName] = useState(event?.name ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [allDay, setAllDay] = useState(Boolean(event?.all_day));
  const [startDate, setStartDate] = useState(initialDays?.start ?? initialStart.date);
  const [startTime, setStartTime] = useState(initialStart.time);
  const [endDate, setEndDate] = useState(initialDays?.end ?? initialEnd.date);
  const [endTime, setEndTime] = useState(initialEnd.time);
  const [emoji, setEmoji] = useState(event?.emoji ?? null);
  const [color, setColor] = useState(event?.color ?? null);
  // How many may go (the rest wait), as typed; '' for no limit.
  const [limit, setLimit] = useState(event?.rsvp_limit != null ? String(event.rsvp_limit) : '');
  const [limited, setLimited] = useState(event?.rsvp_limit != null);
  // The emoji picker's place (its button's rect), while it's open.
  const [picking, setPicking] = useState(null);
  const closePicker = useCallback(() => setPicking(null), []);
  const [repeat, setRepeat] = useState(repeatKey(event?.recurrence));
  const [image, setImage] = useState(event?.image ?? null);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const whole = allDayTimes(startDate, endDate);
  const startAt = allDay ? whole.startTime : fromInputs(startDate, startTime);
  const endAt = allDay ? whole.endTime : fromInputs(endDate, endTime);
  const startDay = startAt != null ? new Date(startAt * 1000) : null;
  const choices = startDay ? repeatChoices(startDay) : [];
  // A rule the editor can't make (a bot's) stays as it is unless another is picked.
  const rule = repeat === 'custom' ? event?.recurrence : startDay ? ruleFor(repeat, startDay) : null;
  const started = event?.status === 'active';
  const typedLimit = Number(limit);
  const rsvpLimit = limited && Number.isInteger(typedLimit) && typedLimit >= 1 && typedLimit <= MAX_RSVP_LIMIT ? typedLimit : null;

  if (scope === 'this' && event?.recurrence) return <OccurrenceEditor view={event} onSaved={onSaved} onClose={onClose} />;
  const following = scope === 'following' && Boolean(event?.recurrence) && occurrence != null;
  // Editing every date anew drops what single ones changed (the server does): say so.
  const changedDates = scope === 'all' && (series?.occurrences ?? []).length > 0;

  // What's wrong with the step, if anything.
  function problem(at) {
    if (at === 'where') {
      if (entityType === 'voice' && channelId == null) return t('events.editor.errors.channel');
    }
    if (at === 'info') {
      if (!name.trim()) return t('events.editor.errors.name');
      if (startAt == null) return t('events.editor.errors.start');
      // All day, today will do: it only has to have its last day still to come.
      if (!started && (allDay ? endAt : startAt) * 1000 <= Date.now()) return t(allDay ? 'events.editor.errors.pastDay' : 'events.editor.errors.past');
      if (allDay && endDate && endDate < startDate) return t('events.editor.errors.endBeforeDay');
      if (entityType === 'external' && endAt == null) return t('events.editor.errors.endNeeded');
      if (endAt != null && endAt <= startAt) return t('events.editor.errors.endBefore');
      if (repeat !== 'none' && !rule) return t('events.editor.errors.repeat');
      if (limited && rsvpLimit == null) return t('events.editor.errors.limit', { max: MAX_RSVP_LIMIT });
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
    // All day, the last day follows when it would come before the first.
    if (allDay && (!endDate || endDate < value)) setEndDate(value);
    // Weekdays only can't start on a weekend: back to not repeating.
    const day = fromInputs(value, startTime);
    if (day != null && repeat !== 'none' && repeat !== 'custom' && !ruleFor(repeat, new Date(day * 1000))) setRepeat('none');
  }

  function toggleAllDay(on) {
    setAllDay(on);
    if (on && (!endDate || endDate < startDate)) setEndDate(startDate);
  }

  function togglePicker(button) {
    if (picking) return setPicking(null);
    const { top, bottom, left, right } = button.getBoundingClientRect();
    setPicking({ top, bottom, left, right });
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
    location: entityType === 'external' ? location.trim() || null : null,
    startTime: startAt,
    endTime: endAt,
    image,
    recurrence: rule ?? null,
    // Repeats and all-day dates are laid on this device's calendar (a bot's rule keeps its own).
    timezone: rule || allDay ? (repeat === 'custom' ? event.timezone : deviceTimeZone()) : null,
    allDay,
    emoji,
    color,
    rsvpLimit,
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
    timezone: fields.timezone,
    all_day: allDay,
    emoji,
    color,
    rsvp_limit: rsvpLimit,
    user_count: event?.user_count ?? 1,
    rsvp_counts: event?.rsvp_counts ?? { going: 1, maybe: 0, declined: 0, waitlisted: 0 },
  };

  async function save() {
    const found = problem('where') ?? problem('info');
    if (found) return setError(found);
    setBusy(true);
    setError(null);
    try {
      onSaved(editing ? await updateEvent(series.id, fields, following ? { from: occurrence } : {}) : await createEvent(guild.id, fields));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const index = STEPS.indexOf(step);
  const picker = picking && reactionPickerPosition(picking);
  return (
    <Modal
      title={following ? t('events.editor.followingTitle') : editing ? t('events.editor.editTitle') : t('events.editor.createTitle')}
      className="event-editor"
      // A click outside while picking an emoji only closes the picker (so does Escape, see Modal).
      onClose={picking ? closePicker : onClose}
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
            <button type="button" className="event-editor-step" onClick={() => s !== step && goTo(s)}>
              {t(`events.editor.step.${s}`)}
            </button>
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
              <Icon icon={faVolumeHigh} />
              <span>
                <strong>{t('events.editor.voice')}</strong>
                <span className="vc-hint">{voiceChannels.length ? t('events.editor.voiceHint') : t('events.editor.noVoiceChannels')}</span>
              </span>
            </label>
            <label className={`event-place-option${entityType === 'external' ? ' selected' : ''}${canExternal ? '' : ' disabled'}`}>
              <input type="radio" name="event-place" value="external" checked={entityType === 'external'} disabled={!canExternal} onChange={() => setEntityType('external')} />
              <Icon icon={faLocationDot} />
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
              <label htmlFor="event-location">{t('events.editor.locationOptional')}</label>
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
          {following && <p className="vc-hint">{t('events.editor.followingHint', { date: formatEventWhen(event) })}</p>}
          {changedDates && <p className="vc-hint">{t('events.editor.allHint')}</p>}
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
          <label className="event-editor-check">
            <input type="checkbox" checked={allDay} disabled={started} onChange={(e) => toggleAllDay(e.target.checked)} />
            {t('events.editor.allDay')}
          </label>
          <TimeInputs
            label={t('events.editor.start')}
            idPrefix="event-start"
            date={startDate}
            time={startTime}
            onDate={changeStartDate}
            onTime={setStartTime}
            dateOnly={allDay}
            hint={started ? t('events.editor.startedHint') : null}
          />
          <TimeInputs
            label={entityType === 'voice' && !allDay ? t('events.editor.endOptional') : t('events.editor.end')}
            idPrefix="event-end"
            date={endDate}
            time={endTime}
            onDate={setEndDate}
            onTime={setEndTime}
            dateOnly={allDay}
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
          <label className="event-editor-check">
            <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} />
            {t('events.editor.limit')}
          </label>
          {limited && (
            <>
              <label htmlFor="event-limit">{t('events.editor.spots')}</label>
              <input
                id="event-limit"
                type="number"
                inputMode="numeric"
                className="form-control event-editor-limit"
                min={1}
                max={MAX_RSVP_LIMIT}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
              <p className="vc-hint">{t('events.editor.limitHint')}</p>
            </>
          )}
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
              <Icon icon={faImage} /> {uploading ? t('events.editor.uploading') : t('events.editor.addCover')}
            </button>
          )}
          <span className="event-editor-label">{t('events.editor.emoji')}</span>
          <div className="event-editor-emoji">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={Boolean(picking)}
              // Don't let the open picker's outside-click handler close it before this toggles.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => togglePicker(e.currentTarget)}
            >
              {emoji ? <EventEmoji emoji={emoji} /> : <Icon icon={faFaceSmile} />}
              {' '}{emoji ? t('events.editor.changeEmoji') : t('events.editor.addEmoji')}
            </button>
            {emoji && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEmoji(null)}>{t('events.editor.removeEmoji')}</button>}
          </div>
          <span className="event-editor-label" id="event-colour-label">{t('events.editor.colour')}</span>
          <div className="role-colors event-editor-colours" role="radiogroup" aria-labelledby="event-colour-label">
            <button
              type="button"
              role="radio"
              aria-checked={color == null}
              aria-label={t('events.editor.defaultColour')}
              title={t('events.editor.defaultColour')}
              className={`role-color default${color == null ? ' selected' : ''}`}
              onClick={() => setColor(null)}
            />
            {COLOR_SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                role="radio"
                aria-checked={color === swatch}
                aria-label={colorToHex(swatch)}
                className={`role-color${color === swatch ? ' selected' : ''}`}
                style={{ backgroundColor: colorToHex(swatch) }}
                onClick={() => setColor(swatch)}
              />
            ))}
            <label className={`role-color custom${color != null && !COLOR_SWATCHES.includes(color) ? ' selected' : ''}`} title={t('events.editor.customColour')}>
              <input type="color" aria-label={t('events.editor.customColour')} value={colorToHex(color ?? 0x99aab5)} onChange={(e) => setColor(hexToColor(e.target.value))} />
            </label>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="event-editor-review">
          <p className="vc-hint">{t('events.editor.reviewHint')}</p>
          <EventCard event={preview} guild={guild} />
        </div>
      )}

      {error && <p className="error-msg" role="alert">{error}</p>}
      {picker && createPortal(
        <div className={`reaction-picker-anchor event-emoji-anchor${picker.below ? ' below' : ''}`} style={picker.style}>
          <EmojiPicker autoFocus={false} onSelect={setEmoji} onClose={closePicker} />
        </div>,
        document.body
      )}
    </Modal>
  );
}
