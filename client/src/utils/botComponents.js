import { t } from '../i18n';

// Bots' message components and interaction replies, drawn by MessageComponents (see
// server/components.js and server/interactions.js, docs/bots.md).

export const COMPONENT = {
  ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, USER_SELECT: 5, ROLE_SELECT: 6,
  MENTIONABLE_SELECT: 7, CHANNEL_SELECT: 8, LABEL: 18,
};
export const SELECT_TYPES = [COMPONENT.STRING_SELECT, COMPONENT.USER_SELECT, COMPONENT.ROLE_SELECT, COMPONENT.MENTIONABLE_SELECT, COMPONENT.CHANNEL_SELECT];
// Discord's button styles: primary, secondary, success, danger, link.
const BUTTON_CLASSES = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };
export const buttonClass = (style) => BUTTON_CLASSES[style] ?? 'secondary';
export const LINK_STYLE = 5;

// Message flags: a "thinking…" placeholder (a deferred reply), ephemeral.
const LOADING = 1 << 7;
// Ephemeral messages (only the person who used the command sees them) have ids from here up
// (server/interactions.js): never a stored message's.
const EPHEMERAL_ID_BASE = 2 ** 52;

export const isEphemeral = (msg) => Boolean(msg?.ephemeral) || Number(msg?.id) >= EPHEMERAL_ID_BASE;
export const isThinking = (msg) => Boolean((msg?.flags ?? 0) & LOADING) && !msg?.content && !msg?.embeds?.length;

// A component's emoji ({ id, name } or { name }) as text ReactionEmoji draws: Unicode, or a
// custom emoji's `<:name:id>`.
export function emojiText(emoji) {
  if (!emoji) return null;
  if (emoji.id) return `<:${String(emoji.name || 'emoji').replace(/[^A-Za-z0-9_]/g, '_').padEnd(2, '_')}:${emoji.id}>`;
  return emoji.name ?? null;
}

// What a failed interaction shows under its message.
export function interactionError(err) {
  if (err?.response?.status === 504) return t('components.notResponding');
  return t('components.failed');
}

// A select's choices: a string select's own options; for user, role, mentionable and channel
// selects, the guild's members, roles and channels the person can see (`names`: { id: name },
// `roles`: { id: { name, color } }, `channels`: [{ id, name }]). Each { value, label, kind,
// description?, emoji?, color? }.
export function selectChoices(component, { names = {}, roles = {}, channels = [] } = {}) {
  if (component.type === COMPONENT.STRING_SELECT) {
    return (component.options ?? []).map((o) => ({ value: o.value, label: o.label, description: o.description, emoji: o.emoji, kind: 'option' }));
  }
  const users = Object.entries(names).map(([id, name]) => ({ value: String(id), label: name, kind: 'user' }));
  const roleList = Object.entries(roles).map(([id, role]) => ({ value: String(id), label: role.name, color: role.color, kind: 'role' }));
  if (component.type === COMPONENT.USER_SELECT) return users;
  if (component.type === COMPONENT.ROLE_SELECT) return roleList;
  if (component.type === COMPONENT.MENTIONABLE_SELECT) return [...users, ...roleList];
  // Channel selects: Discord's channel types 0 (text), 2 (voice), 11 (thread).
  const wanted = component.channel_types?.length ? component.channel_types : null;
  const typeOf = (c) => (c.type === 'voice' ? 2 : c.type === 'thread' ? 11 : 0);
  return channels
    .filter((c) => ['text', 'voice', 'thread'].includes(c.type ?? 'text') && (!wanted || wanted.includes(typeOf(c))))
    .map((c) => ({ value: String(c.id), label: c.name, kind: 'channel', channelType: c.type }));
}

// The values a select starts with: a string select's default options, others' default_values.
export function defaultValues(component) {
  if (component.type === COMPONENT.STRING_SELECT) return (component.options ?? []).filter((o) => o.default).map((o) => o.value);
  return (component.default_values ?? []).map((v) => String(v.id));
}

// Whether `values` is a choice the select accepts (how many).
export function validSelection(component, values) {
  const min = component.min_values ?? 1;
  const max = component.max_values ?? 1;
  return values.length >= min && values.length <= max;
}

// ---- Dismissing an ephemeral message: MessageRow asks, the channel (useChannel) removes it ----

const dismissListeners = new Set();

export function requestDismiss(messageId) {
  dismissListeners.forEach((listener) => listener(messageId));
}

export function onDismissRequest(listener) {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

// ---- A bot's form: its fields in order, and checking what's been filled in ----

// [{ customId, kind: 'text' | 'select', label, description?, spec }] from a modal's components
// (action rows with one text input, or Label components holding a text input or a select).
export function modalFields(modal) {
  return (modal?.components ?? []).map((c) => {
    const spec = c.type === COMPONENT.LABEL ? c.component : c.components?.[0];
    if (!spec) return null;
    return {
      customId: spec.custom_id,
      kind: spec.type === COMPONENT.TEXT_INPUT ? 'text' : 'select',
      label: c.type === COMPONENT.LABEL ? c.label : spec.label,
      description: c.type === COMPONENT.LABEL ? c.description : undefined,
      spec,
    };
  }).filter(Boolean);
}

// The first problem with `answers` for the form's `fields` ({ customId, message }), or null.
export function modalProblem(fields, answers) {
  for (const field of fields) {
    const value = answers[field.customId];
    if (field.kind === 'text') {
      const text = value ?? '';
      const { min_length: min = 0, max_length: max = 4000, required = true } = field.spec;
      if (required && !text.trim()) return { customId: field.customId, message: t('components.modal.required', { label: field.label }) };
      if (text && text.length < min) return { customId: field.customId, message: t('components.modal.tooShort', { label: field.label, count: min }) };
      if (text.length > max) return { customId: field.customId, message: t('components.modal.tooLong', { label: field.label, count: max }) };
    } else {
      const values = value ?? [];
      const { min_values: min = 1, max_values: max = 1, required = true } = field.spec;
      if ((required || values.length) && values.length < min) return { customId: field.customId, message: t('components.modal.choose', { label: field.label, count: min }) };
      if (values.length > max) return { customId: field.customId, message: t('components.modal.tooMany', { label: field.label, count: max }) };
    }
  }
  return null;
}

// What the form starts with: text inputs' prefilled values, selects' default options.
export function modalInitialAnswers(fields) {
  return Object.fromEntries(fields.map((f) => [
    f.customId,
    f.kind === 'text' ? f.spec.value ?? '' : (f.spec.options ?? []).filter((o) => o.default).map((o) => o.value),
  ]));
}
