// Message components (docs/bots.md): Discord's action rows of buttons and select menus on a
// bot's messages, and the text inputs (and string selects) of the forms ("modals") a bot opens,
// checked against Discord's limits
// (https://discord.com/developers/docs/components/reference). Discord's newer layout
// components (IS_COMPONENTS_V2: sections, containers, text displays...) aren't here.

const TYPE = {
  ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, USER_SELECT: 5, ROLE_SELECT: 6,
  MENTIONABLE_SELECT: 7, CHANNEL_SELECT: 8, LABEL: 18,
};
const BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5, PREMIUM: 6 };
const SELECTS = [TYPE.STRING_SELECT, TYPE.USER_SELECT, TYPE.ROLE_SELECT, TYPE.MENTIONABLE_SELECT, TYPE.CHANNEL_SELECT];
const IS_COMPONENTS_V2 = 1 << 15;
const MAX_ROWS = 5;

function formError(path, message, code = 'BASE_TYPE_INVALID') {
  const { FormError } = require('./routes/webhooks');
  return new FormError(path, message, code);
}

function text(value, path, { max, min = 0, required = false }) {
  if (value == null || value === '') {
    if (required) throw formError(path, 'This field is required', 'BASE_TYPE_REQUIRED');
    return undefined;
  }
  const s = String(value);
  if (s.length < min || s.length > max) throw formError(path, `Must be between ${min} and ${max} in length.`, 'BASE_TYPE_BAD_LENGTH');
  return s;
}

function customId(value, path) {
  return text(value, path, { max: 100, min: 1, required: true });
}

function emoji(value, path) {
  if (value == null) return undefined;
  if (typeof value !== 'object') throw formError(path, 'Must be an object.', 'MODEL_TYPE_CONVERT');
  const out = {};
  if (value.id != null) {
    if (!/^\d{1,20}$/.test(String(value.id))) throw formError([...path, 'id'], 'Invalid emoji', 'BUTTON_COMPONENT_INVALID_EMOJI');
    out.id = String(value.id);
  }
  if (value.name != null) out.name = String(value.name).slice(0, 64);
  if (value.animated) out.animated = true;
  if (!out.id && !out.name) throw formError(path, 'Invalid emoji', 'BUTTON_COMPONENT_INVALID_EMOJI');
  return out;
}

const isWebUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol) && value.length <= 512;
  } catch {
    return false;
  }
};

function button(raw, path) {
  const style = raw.style;
  if (!Object.values(BUTTON_STYLE).includes(style)) throw formError([...path, 'style'], `Value "${style}" is not a valid enum value.`, 'BASE_TYPE_CHOICES');
  if (style === BUTTON_STYLE.PREMIUM) throw formError([...path, 'style'], "Premium buttons aren't supported on Voicaw.", 'BASE_TYPE_CHOICES');
  const out = { type: TYPE.BUTTON, style };
  const label = text(raw.label, [...path, 'label'], { max: 80 });
  const icon = emoji(raw.emoji, [...path, 'emoji']);
  if (label !== undefined) out.label = label;
  if (icon) out.emoji = icon;
  if (!label && !icon) throw formError(path, 'A button needs a label or an emoji.', 'BUTTON_COMPONENT_INVALID');
  if (style === BUTTON_STYLE.LINK) {
    if (raw.custom_id != null) throw formError([...path, 'custom_id'], 'A link button cannot have a custom_id', 'BUTTON_COMPONENT_LINK_HAS_CUSTOM_ID');
    if (!isWebUrl(raw.url)) throw formError([...path, 'url'], 'Not a well formed URL.', 'URL_TYPE_INVALID_URL');
    out.url = raw.url;
  } else {
    if (raw.url != null) throw formError([...path, 'url'], 'Only link buttons can have a url', 'BUTTON_COMPONENT_NON_LINK_HAS_URL');
    out.custom_id = customId(raw.custom_id, [...path, 'custom_id']);
  }
  if (raw.disabled) out.disabled = true;
  if (raw.id != null) out.id = raw.id;
  return out;
}

function select(raw, path, { inModal = false } = {}) {
  const out = { type: raw.type, custom_id: customId(raw.custom_id, [...path, 'custom_id']) };
  const placeholder = text(raw.placeholder, [...path, 'placeholder'], { max: 150 });
  if (placeholder !== undefined) out.placeholder = placeholder;
  const count = (key, min, fallback) => {
    if (raw[key] == null) return fallback;
    if (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > 25) throw formError([...path, key], `Must be between ${min} and 25.`, 'NUMBER_TYPE_MAX');
    return raw[key];
  };
  out.min_values = count('min_values', 0, 1);
  out.max_values = count('max_values', 1, 1);
  if (out.min_values > out.max_values) throw formError([...path, 'min_values'], 'Must be less than or equal to max_values.', 'NUMBER_TYPE_MAX');
  if (raw.type === TYPE.STRING_SELECT) {
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 25) {
      throw formError([...path, 'options'], 'Must be between 1 and 25 in length.', 'BASE_TYPE_BAD_LENGTH');
    }
    const values = new Set();
    out.options = raw.options.map((o, i) => {
      const at = [...path, 'options', i];
      const option = {
        label: text(o?.label, [...at, 'label'], { max: 100, min: 1, required: true }),
        value: text(o?.value, [...at, 'value'], { max: 100, min: 1, required: true }),
      };
      if (values.has(option.value)) throw formError([...at, 'value'], 'Select option values must be unique', 'SELECT_COMPONENT_OPTION_VALUE_DUPLICATED');
      values.add(option.value);
      const description = text(o.description, [...at, 'description'], { max: 100 });
      if (description !== undefined) option.description = description;
      const icon = emoji(o.emoji, [...at, 'emoji']);
      if (icon) option.emoji = icon;
      if (o.default) option.default = true;
      return option;
    });
    if (out.max_values > out.options.length) out.max_values = out.options.length;
  } else {
    if (inModal) throw formError([...path, 'type'], 'Only string selects can be in a modal on Voicaw.', 'COMPONENT_TYPE_INVALID');
    if (raw.type === TYPE.CHANNEL_SELECT && Array.isArray(raw.channel_types)) out.channel_types = raw.channel_types.filter(Number.isInteger);
    if (Array.isArray(raw.default_values)) {
      out.default_values = raw.default_values.slice(0, 25)
        .filter((v) => v && /^\d{1,20}$/.test(String(v.id)) && ['user', 'role', 'channel'].includes(v.type))
        .map((v) => ({ id: String(v.id), type: v.type }));
    }
  }
  if (inModal) out.required = raw.required !== false;
  if (raw.disabled) out.disabled = true;
  if (raw.id != null) out.id = raw.id;
  return out;
}

function textInput(raw, path, label) {
  const style = raw.style ?? 1;
  if (![1, 2].includes(style)) throw formError([...path, 'style'], `Value "${style}" is not a valid enum value.`, 'BASE_TYPE_CHOICES');
  const out = { type: TYPE.TEXT_INPUT, custom_id: customId(raw.custom_id, [...path, 'custom_id']), style };
  // In an action row a text input has its own label; inside a Label component, that one's.
  if (label === undefined) out.label = text(raw.label, [...path, 'label'], { max: 45, min: 1, required: true });
  for (const key of ['min_length', 'max_length']) {
    if (raw[key] == null) continue;
    const n = raw[key];
    if (!Number.isInteger(n) || n < (key === 'min_length' ? 0 : 1) || n > 4000) throw formError([...path, key], 'Must be between 0 and 4000.', 'NUMBER_TYPE_MAX');
    out[key] = n;
  }
  out.required = raw.required !== false;
  const value = text(raw.value, [...path, 'value'], { max: 4000 });
  const placeholder = text(raw.placeholder, [...path, 'placeholder'], { max: 100 });
  if (value !== undefined) out.value = value;
  if (placeholder !== undefined) out.placeholder = placeholder;
  return out;
}

// A message's components: up to 5 action rows, each up to 5 buttons or one select. Custom ids
// are unique in the message. Returns the cleaned list. `flags` with IS_COMPONENTS_V2 is refused.
function cleanMessageComponents(raw, flags = 0) {
  if (raw == null) return [];
  if (Number(flags) & IS_COMPONENTS_V2) throw formError(['flags'], "Discord's layout components (IS_COMPONENTS_V2) aren't supported on Voicaw.", 'BASE_TYPE_INVALID');
  if (!Array.isArray(raw)) throw formError(['components'], 'Must be an array.', 'BASE_TYPE_ARRAY');
  if (raw.length > MAX_ROWS) throw formError(['components'], `Must be ${MAX_ROWS} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
  const ids = new Set();
  const rows = raw.map((row, r) => {
    const path = ['components', r];
    if (row?.type !== TYPE.ACTION_ROW) throw formError([...path, 'type'], 'Only action rows can be at the top level on Voicaw.', 'COMPONENT_TYPE_INVALID');
    const children = row.components;
    if (!Array.isArray(children) || children.length < 1 || children.length > 5) {
      throw formError([...path, 'components'], 'Must be between 1 and 5 in length.', 'BASE_TYPE_BAD_LENGTH');
    }
    const cleaned = children.map((c, i) => {
      const at = [...path, 'components', i];
      if (c?.type === TYPE.BUTTON) return button(c, at);
      if (SELECTS.includes(c?.type)) {
        if (children.length !== 1) throw formError(at, 'A select menu must be alone in its row.', 'COMPONENT_LAYOUT_WIDTH_EXCEEDED');
        return select(c, at);
      }
      throw formError([...at, 'type'], `Component type ${c?.type} can't be in a message row.`, 'COMPONENT_TYPE_INVALID');
    });
    for (const c of cleaned) {
      if (!c.custom_id) continue;
      if (ids.has(c.custom_id)) throw formError(path, 'Component custom id cannot be duplicated', 'COMPONENT_CUSTOM_ID_DUPLICATED');
      ids.add(c.custom_id);
    }
    return { type: TYPE.ACTION_ROW, components: cleaned };
  });
  return rows;
}

// A modal (interaction response type 9): { custom_id, title, components } where components are
// 1–5 action rows each holding one text input, or Label components (18) holding a text input or
// a string select. Returns it cleaned.
function cleanModal(raw) {
  if (!raw || typeof raw !== 'object') throw formError(['data'], 'This field is required', 'BASE_TYPE_REQUIRED');
  const modal = {
    custom_id: customId(raw.custom_id, ['data', 'custom_id']),
    title: text(raw.title, ['data', 'title'], { max: 45, min: 1, required: true }),
  };
  if (!Array.isArray(raw.components) || raw.components.length < 1 || raw.components.length > 5) {
    throw formError(['data', 'components'], 'Must be between 1 and 5 in length.', 'BASE_TYPE_BAD_LENGTH');
  }
  const ids = new Set();
  modal.components = raw.components.map((c, i) => {
    const path = ['data', 'components', i];
    let out;
    if (c?.type === TYPE.ACTION_ROW) {
      const [only] = c.components ?? [];
      if (c.components?.length !== 1 || only?.type !== TYPE.TEXT_INPUT) {
        throw formError([...path, 'components'], 'A modal row holds exactly one text input.', 'COMPONENT_TYPE_INVALID');
      }
      out = { type: TYPE.ACTION_ROW, components: [textInput(only, [...path, 'components', 0])] };
    } else if (c?.type === TYPE.LABEL) {
      const label = text(c.label, [...path, 'label'], { max: 45, min: 1, required: true });
      const inner = c.component;
      const innerPath = [...path, 'component'];
      let component;
      if (inner?.type === TYPE.TEXT_INPUT) component = textInput(inner, innerPath, label);
      else if (inner?.type === TYPE.STRING_SELECT) component = select(inner, innerPath, { inModal: true });
      else throw formError([...innerPath, 'type'], 'A label holds a text input or a string select on Voicaw.', 'COMPONENT_TYPE_INVALID');
      out = { type: TYPE.LABEL, label, component };
      const description = text(c.description, [...path, 'description'], { max: 100 });
      if (description !== undefined) out.description = description;
    } else {
      throw formError([...path, 'type'], `Component type ${c?.type} can't be in a modal on Voicaw.`, 'COMPONENT_TYPE_INVALID');
    }
    const field = out.components?.[0] ?? out.component;
    if (ids.has(field.custom_id)) throw formError(path, 'Component custom id cannot be duplicated', 'COMPONENT_CUSTOM_ID_DUPLICATED');
    ids.add(field.custom_id);
    return out;
  });
  return modal;
}

// The fields of a modal, in order: [{ custom_id, kind: 'text' | 'select', spec }].
function modalFields(modal) {
  return modal.components.map((c) => {
    const spec = c.components?.[0] ?? c.component;
    return { custom_id: spec.custom_id, kind: spec.type === TYPE.TEXT_INPUT ? 'text' : 'select', spec, wrapped: c.type };
  });
}

// What was filled in (`answers`: { [custom_id]: string | string[] }) checked against `modal`,
// as Discord's MODAL_SUBMIT data components (the same structure the modal used). Returns null
// when something doesn't fit.
function modalSubmission(modal, answers) {
  const components = [];
  for (const field of modalFields(modal)) {
    const answer = answers?.[field.custom_id];
    let submitted;
    if (field.kind === 'text') {
      const value = typeof answer === 'string' ? answer : '';
      const { min_length: min = 0, max_length: max = 4000, required } = field.spec;
      if ((required && !value) || (value && (value.length < min || value.length > max))) return null;
      submitted = { type: TYPE.TEXT_INPUT, custom_id: field.custom_id, value };
    } else {
      const values = Array.isArray(answer) ? answer.map(String) : [];
      const allowed = new Set(field.spec.options.map((o) => o.value));
      if (values.some((v) => !allowed.has(v)) || new Set(values).size !== values.length) return null;
      if (values.length > field.spec.max_values) return null;
      if (values.length < field.spec.min_values && (field.spec.required || values.length)) return null;
      submitted = { type: TYPE.STRING_SELECT, custom_id: field.custom_id, values };
    }
    components.push(field.wrapped === TYPE.LABEL
      ? { type: TYPE.LABEL, component: submitted }
      : { type: TYPE.ACTION_ROW, components: [submitted] });
  }
  return components;
}

// The component `customId` in a message's (stored) components, or null.
function findComponent(components, customIdValue) {
  for (const row of components ?? []) {
    for (const c of row.components ?? []) if (c.custom_id === customIdValue) return c;
  }
  return null;
}

module.exports = {
  TYPE,
  BUTTON_STYLE,
  SELECTS,
  cleanMessageComponents,
  cleanModal,
  modalFields,
  modalSubmission,
  findComponent,
};
