import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { faFaceSmile } from '@fortawesome/free-solid-svg-icons';
import Modal from './guild/Modal';
import EmojiPicker from './EmojiPicker';
import { ReactionEmoji } from './MessageReactions';
import {
  MAX_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  MAX_QUESTION_LENGTH,
  DEFAULT_POLL_DURATION,
  POLL_DURATIONS,
  editedPoll,
  newOptionId,
  optionChanged,
} from '../utils/pollMarkup';
import { reactionPickerPosition } from '../utils/reactionPickerPosition';
import { t } from '../i18n';

// Making a poll, or editing one (`poll`): a question and 1 to MAX_POLL_OPTIONS answers
// (empty rows are left out), each with an optional emoji (the smiley button: the emoji
// picker), how long it runs, whether more than one answer can be picked and whether anyone
// can add answers (an open poll; none of these three can be changed afterwards).
// Editing an answer's text or emoji drops its votes, and changing the question drops them all,
// with the answers people added (see editedPoll). While those stay, `addedAnswers` (how many
// there are) take places from MAX_POLL_OPTIONS.
// `onSubmit(poll)` (async) posts or saves it; its error is shown here.
export default function PollDialog({ poll, addedAnswers = 0, onSubmit, onClose }) {
  const editing = Boolean(poll);
  const nextKey = useRef(0);
  const row = (option) => ({ key: nextKey.current++, id: option?.id ?? null, text: option?.text ?? '', emoji: option?.emoji ?? null });
  const [question, setQuestion] = useState(poll?.question ?? '');
  const [options, setOptions] = useState(() => (poll ? poll.options.map(row) : [row(), row()]));
  const [multi, setMulti] = useState(poll?.multi ?? false);
  const [open, setOpen] = useState(poll?.open ?? false);
  const newQuestion = editing && question.trim() !== poll.question;
  const maxOptions = MAX_POLL_OPTIONS - (newQuestion ? 0 : addedAnswers);
  const [duration, setDuration] = useState(poll ? poll.duration : DEFAULT_POLL_DURATION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const listRef = useRef(null);
  // The answer whose emoji is being picked: { key, rect } (of its button).
  const [pickingFor, setPickingFor] = useState(null);
  const closePicker = useCallback(() => setPickingFor(null), []);

  const filled = options.filter((o) => o.text.trim());
  const valid = question.trim() && filled.length > 0;

  const setText = (key, text) => setOptions((list) => list.map((o) => (o.key === key ? { ...o, text } : o)));
  const setEmoji = (key, emoji) => setOptions((list) => list.map((o) => (o.key === key ? { ...o, emoji } : o)));
  const remove = (key) => setOptions((list) => list.filter((o) => o.key !== key));

  function togglePicker(key, button) {
    if (pickingFor?.key === key) return setPickingFor(null);
    const { top, bottom, left, right } = button.getBoundingClientRect();
    setPickingFor({ key, rect: { top, bottom, left, right } });
  }

  function addOption() {
    setOptions((list) => [...list, row()]);
    // Focus the new answer once it's there.
    requestAnimationFrame(() => {
      const inputs = listRef.current?.querySelectorAll('input');
      inputs?.[inputs.length - 1]?.focus();
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!valid || busy) return;
    const answers = filled.map((o) => ({ id: o.id, text: o.text.trim(), emoji: o.emoji }));
    const next = editing
      ? editedPoll(poll, { question: question.trim(), options: answers })
      : {
          question: question.trim(),
          multi,
          open,
          round: open ? newOptionId() : null,
          duration,
          options: answers.map((o) => ({ ...o, id: newOptionId() })),
        };
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || t('chat.pollDialog.saveFailed'));
      setBusy(false);
    }
  }

  // An answer of an existing poll whose text or emoji has been changed loses its votes.
  const changed = editing && options.some((o) => o.id && o.text.trim() && optionChanged(poll, { ...o, text: o.text.trim() }));
  const picker = pickingFor && reactionPickerPosition(pickingFor.rect);

  return (
    <Modal
      title={editing ? t('chat.pollDialog.editTitle') : t('chat.pollDialog.createTitle')}
      className="poll-dialog"
      // A click outside while picking an emoji only closes the picker (so does Escape, see Modal).
      onClose={pickingFor ? closePicker : onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="poll-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !valid}>
            {editing ? t('common.save') : t('chat.pollDialog.post')}
          </button>
        </>
      )}
    >
      <form id="poll-form" className="vc-form" onSubmit={submit}>
        <label htmlFor="poll-question">{t('chat.pollDialog.question')}</label>
        <input
          id="poll-question"
          className="form-control"
          maxLength={MAX_QUESTION_LENGTH}
          placeholder={t('chat.pollDialog.questionPlaceholder')}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          autoFocus
        />

        <label>{t('chat.pollDialog.answers')}</label>
        {/* Tab goes question → each answer → Add another answer: the emoji and remove buttons
            beside each answer are left out of it (they're for the mouse or a tap). */}
        <div className="poll-dialog-options" ref={listRef}>
          {options.map((o, i) => (
            <div key={o.key} className="vc-form-row">
              <span className="poll-dialog-emoji">
                <button
                  type="button"
                  className="poll-dialog-emoji-button"
                  tabIndex={-1}
                  aria-label={o.emoji ? t('chat.pollDialog.changeEmojiOf', { number: i + 1 }) : t('chat.pollDialog.addEmojiTo', { number: i + 1 })}
                  title={o.emoji ? t('chat.pollDialog.changeEmoji') : t('chat.pollDialog.addEmoji')}
                  aria-expanded={pickingFor?.key === o.key}
                  // Don't let the open picker's outside-click handler close it before this toggles.
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => togglePicker(o.key, e.currentTarget)}
                >
                  {o.emoji ? <ReactionEmoji native={o.emoji} /> : <Icon icon={faFaceSmile} />}
                </button>
                {o.emoji && (
                  <button
                    type="button"
                    className="poll-dialog-emoji-clear"
                    tabIndex={-1}
                    aria-label={t('chat.pollDialog.removeEmojiOf', { number: i + 1 })}
                    title={t('chat.pollDialog.removeEmoji')}
                    onClick={() => setEmoji(o.key, null)}
                  >
                    ×
                  </button>
                )}
              </span>
              <input
                className="form-control"
                aria-label={t('chat.pollDialog.answer', { number: i + 1 })}
                maxLength={MAX_OPTION_LENGTH}
                placeholder={t('chat.pollDialog.answerPlaceholder')}
                value={o.text}
                onChange={(e) => setText(o.key, e.target.value)}
              />
              <button
                type="button"
                className="poll-dialog-remove"
                tabIndex={-1}
                aria-label={t('chat.pollDialog.removeAnswerNumber', { number: i + 1 })}
                title={t('chat.pollDialog.removeAnswer')}
                disabled={options.length <= 1}
                onClick={() => remove(o.key)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {options.length < maxOptions && (
          <button type="button" className="btn btn-secondary btn-sm poll-dialog-add" onClick={addOption}>
            {t('chat.pollDialog.addAnswer')}
          </button>
        )}
        {newQuestion
          ? <p className="vc-hint">{poll.open ? t('chat.pollDialog.questionChangedOpen') : t('chat.pollDialog.questionChanged')}</p>
          : changed && <p className="vc-hint">{t('chat.pollDialog.changedHint')}</p>}

        <label htmlFor="poll-duration">{t('chat.pollDialog.duration')}</label>
        <select
          id="poll-duration"
          className="form-select form-control"
          value={duration ?? ''}
          disabled={editing}
          onChange={(e) => setDuration(Number(e.target.value))}
        >
          {/* A poll from before durations runs until its author ends it. */}
          {duration == null && <option value="">{t('chat.pollDialog.noEnd')}</option>}
          {POLL_DURATIONS.map((d) => <option key={d.seconds} value={d.seconds}>{d.label}</option>)}
        </select>

        <label className="role-toggle">
          <input type="checkbox" checked={multi} disabled={editing} onChange={(e) => setMulti(e.target.checked)} />
          <span>
            <strong>{t('chat.pollDialog.multi')}</strong>
            <span className="vc-hint">{editing ? t('chat.pollDialog.multiLocked') : t('chat.pollDialog.multiHint')}</span>
          </span>
        </label>

        <label className="role-toggle">
          <input type="checkbox" checked={open} disabled={editing} onChange={(e) => setOpen(e.target.checked)} />
          <span>
            <strong>{t('chat.pollDialog.open')}</strong>
            <span className="vc-hint">{editing ? t('chat.pollDialog.openLocked') : t('chat.pollDialog.openHint')}</span>
          </span>
        </label>
      </form>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {picker && createPortal(
        <div className={`reaction-picker-anchor poll-emoji-anchor${picker.below ? ' below' : ''}`} style={picker.style}>
          <EmojiPicker
            autoFocus={false}
            onSelect={(emoji) => setEmoji(pickingFor.key, emoji)}
            onClose={closePicker}
          />
        </div>,
        document.body
      )}
    </Modal>
  );
}
