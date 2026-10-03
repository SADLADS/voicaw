import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import Avatar from './Avatar';
import { runCommand, handleInteractionResult } from '../services/interactionService';
import { useCommandAutocomplete } from '../hooks/useCommandAutocomplete';
import {
  OPTION, buildOptions, channelsFor, interactionError, missingOptions, optionProblem,
} from '../utils/commandOptions';
import { displayName, nameOf } from '../utils/profiles';
import { t } from '../i18n';

// The message box in "command mode" (like Discord's), once a bot command was picked from the
// "/" list: `/name sub` and a field for each of its options (text, numbers, true/false, a
// member, role or channel from the guild, a file; a list for options with choices, and the
// bot's suggestions for autocomplete ones). Required ones are marked; Enter or Send runs it
// once they're filled (runCommand), Escape or × leaves. What the bot answers comes by socket
// (a form opens through handleInteractionResult); a failure shows here, keeping the fields.
// `people` ([{ id, username, ... }]), `roleInfo` ({ id: { name, color } }) and `channels`
// ([{ id, name, type }]) are the guild's, for the pickers.
export default function CommandComposer({ entry, channelId, people, roleInfo, channels, onClose }) {
  const [values, setValues] = useState({});
  const [labels, setLabels] = useState({}); // shown in place of an autocomplete choice's value
  const [focused, setFocused] = useState(null); // the autocomplete option being typed in
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [triedSend, setTriedSend] = useState(false);
  const firstField = useRef(null);
  const { choices, loading } = useCommandAutocomplete(channelId, entry, values, focused);

  useEffect(() => {
    firstField.current?.focus();
  }, [entry]);

  const set = (name, value, label = undefined) => {
    setValues((v) => ({ ...v, [name]: value }));
    setLabels((l) => ({ ...l, [name]: label }));
    setError(null);
  };

  const missing = missingOptions(entry.options, values);
  const problems = Object.fromEntries(entry.options.map((o) => [o.name, optionProblem(o, values[o.name])]).filter(([, p]) => p));
  const ready = !missing.length && !Object.keys(problems).length;

  async function run(e) {
    e?.preventDefault();
    setTriedSend(true);
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    try {
      const { options, files } = buildOptions(entry, values);
      const result = await runCommand(channelId, { commandId: entry.command.id, options, files });
      handleInteractionResult(result);
      onClose();
    } catch (err) {
      setError(interactionError(err));
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && !(focused && choices.length)) {
      e.preventDefault();
      onClose();
    }
  }

  const members = people ?? [];
  const roles = Object.entries(roleInfo ?? {}).map(([id, r]) => ({ id: Number(id), ...r }));

  function field(option, index) {
    const id = `command-option-${option.name}`;
    const value = values[option.name] ?? '';
    const common = {
      id,
      ref: index === 0 ? firstField : undefined,
      className: 'command-option-input',
      disabled: sending,
      'aria-invalid': Boolean(problems[option.name] || (triedSend && missing.includes(option))),
    };
    if (option.choices?.length) {
      return (
        <select {...common} value={value} onChange={(e) => set(option.name, e.target.value)}>
          <option value="">{t('commands.mode.choose')}</option>
          {option.choices.map((c) => <option key={String(c.value)} value={String(c.value)}>{c.name}</option>)}
        </select>
      );
    }
    switch (option.type) {
      case OPTION.BOOLEAN:
        return (
          <select {...common} value={value === '' ? '' : String(value)} onChange={(e) => set(option.name, e.target.value === '' ? '' : e.target.value === 'true')}>
            <option value="">{t('commands.mode.choose')}</option>
            <option value="true">{t('commands.mode.true')}</option>
            <option value="false">{t('commands.mode.false')}</option>
          </select>
        );
      case OPTION.USER:
        return (
          <select {...common} value={value} onChange={(e) => set(option.name, e.target.value)}>
            <option value="">{t('commands.mode.chooseMember')}</option>
            {members.map((m) => <option key={m.id} value={String(m.id)}>{nameOf(m)}</option>)}
          </select>
        );
      case OPTION.ROLE:
        return (
          <select {...common} value={value} onChange={(e) => set(option.name, e.target.value)}>
            <option value="">{t('commands.mode.chooseRole')}</option>
            {roles.map((r) => <option key={r.id} value={String(r.id)}>@{r.name}</option>)}
          </select>
        );
      case OPTION.MENTIONABLE:
        return (
          <select {...common} value={value} onChange={(e) => set(option.name, e.target.value)}>
            <option value="">{t('commands.mode.chooseMentionable')}</option>
            <optgroup label={t('commands.mode.members')}>
              {members.map((m) => <option key={`u${m.id}`} value={String(m.id)}>{nameOf(m)}</option>)}
            </optgroup>
            <optgroup label={t('commands.mode.roles')}>
              {roles.map((r) => <option key={`r${r.id}`} value={String(r.id)}>@{r.name}</option>)}
            </optgroup>
          </select>
        );
      case OPTION.CHANNEL:
        return (
          <select {...common} value={value} onChange={(e) => set(option.name, e.target.value)}>
            <option value="">{t('commands.mode.chooseChannel')}</option>
            {channelsFor(option, channels).map((c) => <option key={c.id} value={String(c.id)}>#{c.name}</option>)}
          </select>
        );
      case OPTION.ATTACHMENT:
        return <input {...common} type="file" onChange={(e) => set(option.name, e.target.files?.[0] ?? '')} />;
      case OPTION.INTEGER:
      case OPTION.NUMBER:
        if (!option.autocomplete) {
          return (
            <input
              {...common}
              type="number"
              inputMode={option.type === OPTION.INTEGER ? 'numeric' : 'decimal'}
              step={option.type === OPTION.INTEGER ? 1 : 'any'}
              min={option.min_value}
              max={option.max_value}
              value={value}
              onChange={(e) => set(option.name, e.target.value)}
            />
          );
        }
        break;
      default:
    }
    // Text, or anything with the bot's suggestions.
    return (
      <span className="command-option-autocomplete">
        <input
          {...common}
          type="text"
          autoComplete="off"
          value={labels[option.name] ?? value}
          maxLength={option.max_length}
          onFocus={() => { if (option.autocomplete) setFocused(option.name); }}
          onBlur={() => setFocused((f) => (f === option.name ? null : f))}
          onChange={(e) => set(option.name, e.target.value)}
          aria-autocomplete={option.autocomplete ? 'list' : undefined}
        />
        {option.autocomplete && focused === option.name && (choices.length > 0 || loading) && (
          <span className="command-option-choices" role="listbox" aria-label={t('commands.mode.suggestions')}>
            {loading && !choices.length && <span className="command-option-choice muted">{t('commands.mode.loading')}</span>}
            {choices.map((c) => (
              <span
                key={String(c.value)}
                role="option"
                aria-selected={String(values[option.name]) === String(c.value)}
                className="command-option-choice"
                onMouseDown={(e) => {
                  e.preventDefault();
                  set(option.name, c.value, c.name);
                  setFocused(null);
                }}
              >
                {c.name}
              </span>
            ))}
          </span>
        )}
      </span>
    );
  }

  return (
    <form className="command-composer" onSubmit={run} onKeyDown={onKeyDown} aria-label={t('commands.mode.label', { name: entry.name })}>
      <div className="command-composer-head">
        <Avatar userId={entry.command.bot?.id} className="mention-suggestion-avatar" />
        <strong className="command-composer-name">/{entry.name}</strong>
        <span className="command-composer-bot">{displayName(entry.command.bot?.id, entry.command.bot?.name)}</span>
        <button type="button" className="reply-close command-composer-close" aria-label={t('commands.mode.leave')} onClick={onClose}>
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </div>
      {entry.description && <div className="command-composer-description">{entry.description}</div>}
      {entry.options.length > 0 && (
        <div className="command-options">
          {entry.options.map((option, i) => (
            <label key={option.name} className="command-option" htmlFor={`command-option-${option.name}`} title={option.description}>
              <span className="command-option-name">
                {option.name}
                {option.required && <span className="command-option-required" aria-label={t('commands.mode.required')}>*</span>}
              </span>
              {field(option, i)}
              {problems[option.name] && <span className="command-option-problem">{problems[option.name]}</span>}
            </label>
          ))}
        </div>
      )}
      {triedSend && missing.length > 0 && (
        <div className="command-composer-error" role="alert">{t('commands.mode.missing', { names: missing.map((o) => o.name).join(', ') })}</div>
      )}
      {error && <div className="command-composer-error" role="alert">{error}</div>}
      <div className="command-composer-actions">
        {sending && <span className="vc-hint">{t('commands.mode.sending')}</span>}
        <button type="submit" className="send-button" disabled={sending} ref={entry.options.length ? undefined : firstField}>
          {t('commands.mode.run')}
        </button>
      </div>
    </form>
  );
}
