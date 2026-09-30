import React, { useRef, useState } from 'react';
import Modal from './guild/Modal';
import {
  MAX_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  MAX_QUESTION_LENGTH,
  editedPoll,
  newOptionId,
} from '../utils/pollMarkup';

// Making a poll, or editing one (`poll`): a question and 1 to MAX_POLL_OPTIONS answers
// (empty rows are left out), and whether more than one answer can be picked, which can't be
// changed afterwards. Editing an answer's text drops its votes (see editedPoll).
// `onSubmit(poll)` (async) posts or saves it; its error is shown here.
export default function PollDialog({ poll, onSubmit, onClose }) {
  const editing = Boolean(poll);
  const nextKey = useRef(0);
  const row = (option) => ({ key: nextKey.current++, id: option?.id ?? null, text: option?.text ?? '' });
  const [question, setQuestion] = useState(poll?.question ?? '');
  const [options, setOptions] = useState(() => (poll ? poll.options.map(row) : [row(), row()]));
  const [multi, setMulti] = useState(poll?.multi ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const listRef = useRef(null);

  const filled = options.filter((o) => o.text.trim());
  const valid = question.trim() && filled.length > 0;

  const setText = (key, text) => setOptions((list) => list.map((o) => (o.key === key ? { ...o, text } : o)));
  const remove = (key) => setOptions((list) => list.filter((o) => o.key !== key));

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
    const answers = filled.map((o) => ({ id: o.id, text: o.text.trim() }));
    const next = editing
      ? editedPoll(poll, { question: question.trim(), options: answers })
      : { question: question.trim(), multi, options: answers.map((o) => ({ id: newOptionId(), text: o.text })) };
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Couldn't save the poll.");
      setBusy(false);
    }
  }

  // An answer of an existing poll whose text has been changed loses its votes.
  const changed = editing && options.some((o) => o.id && poll.options.find((p) => p.id === o.id)?.text !== o.text.trim());

  return (
    <Modal
      title={editing ? 'Edit poll' : 'Create a poll'}
      className="poll-dialog"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" form="poll-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !valid}>
            {editing ? 'Save' : 'Post'}
          </button>
        </>
      )}
    >
      <form id="poll-form" className="vc-form" onSubmit={submit}>
        <label htmlFor="poll-question">Question</label>
        <input
          id="poll-question"
          className="form-control"
          maxLength={MAX_QUESTION_LENGTH}
          placeholder="What would you like to ask?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          autoFocus
        />

        <label>Answers</label>
        <div className="poll-dialog-options" ref={listRef}>
          {options.map((o, i) => (
            <div key={o.key} className="vc-form-row">
              <input
                className="form-control"
                aria-label={`Answer ${i + 1}`}
                maxLength={MAX_OPTION_LENGTH}
                placeholder="Type your answer"
                value={o.text}
                onChange={(e) => setText(o.key, e.target.value)}
              />
              <button
                type="button"
                className="poll-dialog-remove"
                aria-label={`Remove answer ${i + 1}`}
                title="Remove answer"
                disabled={options.length <= 1}
                onClick={() => remove(o.key)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {options.length < MAX_POLL_OPTIONS && (
          <button type="button" className="btn btn-secondary btn-sm poll-dialog-add" onClick={addOption}>
            + Add another answer
          </button>
        )}
        {changed && <p className="vc-hint">Changing an answer removes the votes it had.</p>}

        <label className="role-toggle">
          <input type="checkbox" checked={multi} disabled={editing} onChange={(e) => setMulti(e.target.checked)} />
          <span>
            <strong>Allow multiple answers</strong>
            <span className="vc-hint">{editing ? "Can't be changed after posting." : "Can't be changed once the poll is posted."}</span>
          </span>
        </label>
      </form>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
