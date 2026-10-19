import React, { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { faArrowUpRightFromSquare, faCheck, faChevronDown, faHashtag, faVolumeHigh, faAt, faSpinner } from '@fortawesome/free-solid-svg-icons';
import { ReactionEmoji } from './MessageReactions';
import Avatar from './Avatar';
import { ChannelMentionContext } from '../contexts';
// (Not a React hook despite its name.)
import { useComponent as sendComponentInteraction, handleInteractionResult } from '../services/interactionService';
import {
  COMPONENT, LINK_STYLE, SELECT_TYPES, buttonClass, defaultValues, emojiText, interactionError, selectChoices, validSelection,
} from '../utils/botComponents';
import { t } from '../i18n';
import '../assets/css/bots.css';

// A bot's buttons and select menus under its message (Discord's action rows; server/components.js).
// Clicking or choosing asks the bot (interactionService.useComponent); while it answers the
// component is busy, and if it doesn't, "This interaction failed" shows for a few seconds. A
// link button just opens its address (no referrer). Memoised: it takes only the message's id,
// its components and the guild's (stable) names and roles.

const ERROR_MS = 5000;

function ComponentEmoji({ emoji }) {
  const text = emojiText(emoji);
  return text ? <span className="bot-component-emoji"><ReactionEmoji native={text} /></span> : null;
}

function ChoiceIcon({ choice }) {
  if (choice.kind === 'user') return <Avatar userId={Number(choice.value)} alt="" className="bot-select-avatar" />;
  if (choice.kind === 'role') return <Icon icon={faAt} className="bot-select-icon" style={choice.color ? { color: choice.color } : undefined} />;
  if (choice.kind === 'channel') return <Icon icon={choice.channelType === 'voice' ? faVolumeHigh : faHashtag} className="bot-select-icon" />;
  if (choice.emoji) return <ComponentEmoji emoji={choice.emoji} />;
  return null;
}

function BotButton({ component, busy, disabled, onClick }) {
  const style = buttonClass(component.style);
  const content = (
    <>
      {busy ? <Icon icon={faSpinner} spin className="bot-component-emoji" /> : <ComponentEmoji emoji={component.emoji} />}
      {component.label && <span className="bot-button-label">{component.label}</span>}
      {component.style === LINK_STYLE && <Icon icon={faArrowUpRightFromSquare} className="bot-button-link-icon" />}
    </>
  );
  if (component.style === LINK_STYLE) {
    if (component.disabled) return <span className={`bot-button ${style} disabled`} aria-disabled="true">{content}</span>;
    return (
      <a className={`bot-button ${style}`} href={component.url} target="_blank" rel="noopener noreferrer" title={t('components.linkTitle', { url: component.url })}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={`bot-button ${style}${busy ? ' busy' : ''}`} disabled={disabled || component.disabled} aria-busy={busy || undefined} onClick={onClick}>
      {content}
    </button>
  );
}

// A select menu: a field showing the choice (or the placeholder) that opens the list. One choice:
// picked at once. Several: ticked, then Done (or closing the list) sends them.
function BotSelect({ component, choices, busy, disabled, onChoose }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(() => defaultValues(component));
  const ref = useRef(null);
  const multiple = (component.max_values ?? 1) > 1;
  const max = component.max_values ?? 1;

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const labelOf = (value) => choices.find((c) => c.value === value)?.label ?? value;
  const summary = picked.length === 0
    ? component.placeholder || t('components.selectPlaceholder')
    : picked.length === 1 ? labelOf(picked[0]) : t('components.selectCount', { count: picked.length });

  // Once sent, the select shows its defaults again (as in Discord); the bot's answer, if it
  // changes the message, is what stays.
  const send = (values) => {
    setOpen(false);
    if (!validSelection(component, values)) return;
    onChoose(values);
    setPicked(defaultValues(component));
  };
  const toggle = (value) => {
    if (!multiple) {
      send([value]);
      return;
    }
    setPicked((now) => (now.includes(value) ? now.filter((v) => v !== value) : now.length < max ? [...now, value] : now));
  };
  const inactive = disabled || component.disabled;

  return (
    <div className={`bot-select${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className={`bot-select-field${picked.length ? '' : ' placeholder'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={inactive}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="bot-select-summary">{summary}</span>
        {busy ? <Icon icon={faSpinner} spin /> : <Icon icon={faChevronDown} />}
      </button>
      {open && (
        <div className="bot-select-menu">
          <ul role="listbox" aria-multiselectable={multiple || undefined} aria-label={component.placeholder || t('components.selectPlaceholder')}>
            {choices.length === 0 && <li className="bot-select-empty">{t('components.noChoices')}</li>}
            {choices.map((choice) => {
              const selected = picked.includes(choice.value);
              return (
                <li key={`${choice.kind}:${choice.value}`}>
                  <button type="button" role="option" aria-selected={selected} className={`bot-select-option${selected ? ' selected' : ''}`} onClick={() => toggle(choice.value)}>
                    <ChoiceIcon choice={choice} />
                    <span className="bot-select-text">
                      <span className="bot-select-label">{choice.label}</span>
                      {choice.description && <span className="bot-select-description">{choice.description}</span>}
                    </span>
                    {selected && <Icon icon={faCheck} className="bot-select-check" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {multiple && (
            <div className="bot-select-actions">
              <button type="button" className="btn btn-primary btn-sm vc-button" disabled={!validSelection(component, picked)} onClick={() => send(picked)}>
                {t('components.selectDone')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MessageComponents = memo(function MessageComponents({ messageId, channelId, components, names, roles }) {
  const directory = useContext(ChannelMentionContext);
  const [busy, setBusy] = useState(null); // custom_id waiting for the bot
  const [error, setError] = useState(null);
  const errorTimer = useRef(null);
  useEffect(() => () => clearTimeout(errorTimer.current), []);

  // The channels of this message's guild you can see (for channel selects).
  const channels = useMemo(() => {
    const guildId = directory?.channels?.[channelId]?.guildId;
    return Object.values(directory?.channels ?? {}).filter((c) => guildId == null || c.guildId === guildId);
  }, [directory, channelId]);

  if (!components?.length) return null;

  async function run(customId, values) {
    if (busy) return;
    setBusy(customId);
    setError(null);
    try {
      handleInteractionResult(await sendComponentInteraction(messageId, customId, values));
    } catch (err) {
      setError(interactionError(err));
      clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setError(null), ERROR_MS);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bot-components">
      {components.map((row, r) => (
        row.type === COMPONENT.ACTION_ROW && (
          <div className="bot-component-row" key={r}>
            {(row.components ?? []).map((c, i) => {
              const key = c.custom_id ?? c.url ?? i;
              if (c.type === COMPONENT.BUTTON) {
                return <BotButton key={key} component={c} busy={busy === c.custom_id} disabled={busy != null} onClick={() => run(c.custom_id)} />;
              }
              if (SELECT_TYPES.includes(c.type)) {
                return (
                  <BotSelect
                    key={key}
                    component={c}
                    choices={selectChoices(c, { names, roles, channels })}
                    busy={busy === c.custom_id}
                    disabled={busy != null}
                    onChoose={(values) => run(c.custom_id, values)}
                  />
                );
              }
              return null;
            })}
          </div>
        )
      ))}
      {error && <p className="bot-component-error" role="alert">{error}</p>}
    </div>
  );
});

export default MessageComponents;
