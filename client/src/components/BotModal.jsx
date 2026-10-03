import React, { useEffect, useMemo, useState } from 'react';
import Modal from './guild/Modal';
import Avatar from './Avatar';
import { onBotModal, closeBotModal, submitModal, handleInteractionResult } from '../services/interactionService';
import { emojiText, interactionError, modalFields, modalInitialAnswers, modalProblem } from '../utils/botComponents';
import { ReactionEmoji } from './MessageReactions';
import { t } from '../i18n';
import '../assets/css/bots.css';

// A bot's form ("modal", opened by its answer to a command or button; interactionService
// showBotModal): its text inputs and choices, checked here as the bot asked, then sent to it
// (submitModal). Mounted once (Layout); one form at a time.

function SelectField({ field, value, onChange }) {
  const multiple = (field.spec.max_values ?? 1) > 1;
  const toggle = (option) => {
    if (!multiple) return onChange([option]);
    return onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option]);
  };
  return (
    <ul className="bot-modal-options" role="listbox" aria-multiselectable={multiple || undefined} aria-labelledby={`bot-modal-${field.customId}`}>
      {field.spec.options.map((o) => {
        const selected = value.includes(o.value);
        const emoji = emojiText(o.emoji);
        return (
          <li key={o.value}>
            <button type="button" role="option" aria-selected={selected} className={`bot-select-option${selected ? ' selected' : ''}`} onClick={() => toggle(o.value)}>
              <input type={multiple ? 'checkbox' : 'radio'} checked={selected} readOnly tabIndex={-1} aria-hidden="true" />
              {emoji && <span className="bot-component-emoji"><ReactionEmoji native={emoji} /></span>}
              <span className="bot-select-text">
                <span className="bot-select-label">{o.label}</span>
                {o.description && <span className="bot-select-description">{o.description}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BotModalForm({ modal }) {
  const fields = useMemo(() => modalFields(modal), [modal]);
  const [answers, setAnswers] = useState(() => modalInitialAnswers(fields));
  const [problem, setProblem] = useState(null);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);

  async function submit(e) {
    e?.preventDefault();
    const found = modalProblem(fields, answers);
    setProblem(found);
    if (found) return;
    setSending(true);
    setError(null);
    try {
      const result = await submitModal(modal.id, answers);
      closeBotModal();
      handleInteractionResult(result);
    } catch (err) {
      setError(err?.response?.status === 504 ? interactionError(err) : err?.response?.data?.error || interactionError(err));
      setSending(false);
    }
  }

  const set = (customId, value) => setAnswers((now) => ({ ...now, [customId]: value }));

  return (
    <Modal
      title={modal.title}
      onClose={closeBotModal}
      className="bot-modal"
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={closeBotModal}>{t('common.cancel')}</button>
          <button type="submit" form="bot-modal-form" className="btn btn-primary btn-sm vc-button" disabled={sending}>
            {sending ? t('components.modal.sending') : t('components.modal.submit')}
          </button>
        </>
      )}
    >
      {modal.bot && (
        <div className="bot-modal-from">
          <Avatar userId={modal.bot.id} alt="" className="bot-modal-avatar" />
          <span>{t('components.modal.from', { name: modal.bot.name })}</span>
        </div>
      )}
      <form id="bot-modal-form" onSubmit={submit} noValidate>
        {fields.map((field, i) => {
          const id = `bot-modal-${field.customId}`;
          const invalid = problem?.customId === field.customId;
          const required = field.spec.required !== false;
          return (
            <div className={`bot-modal-field${invalid ? ' invalid' : ''}`} key={field.customId}>
              <label className="vc-label" htmlFor={id} id={field.kind === 'select' ? id : undefined}>
                {field.label}{required && <span className="bot-modal-required" aria-hidden="true"> *</span>}
              </label>
              {field.description && <p className="vc-hint">{field.description}</p>}
              {field.kind === 'text' ? (
                field.spec.style === 2 ? (
                  <textarea
                    id={id}
                    className="form-control"
                    rows={4}
                    value={answers[field.customId]}
                    placeholder={field.spec.placeholder}
                    maxLength={field.spec.max_length ?? 4000}
                    aria-invalid={invalid || undefined}
                    autoFocus={i === 0}
                    onChange={(e) => set(field.customId, e.target.value)}
                  />
                ) : (
                  <input
                    id={id}
                    className="form-control"
                    value={answers[field.customId]}
                    placeholder={field.spec.placeholder}
                    maxLength={field.spec.max_length ?? 4000}
                    aria-invalid={invalid || undefined}
                    autoFocus={i === 0}
                    onChange={(e) => set(field.customId, e.target.value)}
                  />
                )
              ) : (
                <SelectField field={field} value={answers[field.customId]} onChange={(v) => set(field.customId, v)} />
              )}
              {invalid && <p className="error-msg" role="alert">{problem.message}</p>}
            </div>
          );
        })}
      </form>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}

export default function BotModal() {
  const [modal, setModal] = useState(null);
  useEffect(() => onBotModal(setModal), []);
  if (!modal) return null;
  // A new form starts from scratch.
  return <BotModalForm key={modal.id} modal={modal} />;
}
