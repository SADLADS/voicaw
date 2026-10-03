import { t } from '../i18n';

// Bots' slash commands in the message box (CommandSuggestions, CommandComposer; server/commands.js
// for their shape). A command with subcommands is picked as one of them ("/name group sub"),
// like Discord's picker; its plain options are then filled in and sent as Discord's options.

export const OPTION = {
  SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7,
  ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11,
};

const isNested = (o) => o.type === OPTION.SUB_COMMAND || o.type === OPTION.SUB_COMMAND_GROUP;

// Slash commands (type 1) as picker entries: { key, command, path (subcommand names), name
// ("hug" or "admin ban"), description, options (the plain ones to fill in) }.
export function commandEntries(commands) {
  const entries = [];
  for (const command of commands ?? []) {
    if (command.type !== 1) continue;
    const options = command.options ?? [];
    const walk = (list, path, description) => {
      const nested = list.filter(isNested);
      if (!nested.length) {
        entries.push({
          key: `${command.id}:${path.join(' ')}`,
          command,
          path,
          name: [command.name, ...path].join(' '),
          description,
          options: list,
        });
        return;
      }
      for (const o of nested) walk(o.options ?? [], [...path, o.name], o.description);
    };
    walk(options, [], command.description);
  }
  return entries;
}

// The entries whose name starts with (then contains) `query`, best first.
export function searchCommands(entries, query, limit = 25) {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const starts = entries.filter((e) => e.name.toLowerCase().startsWith(q));
  const contains = entries.filter((e) => !starts.includes(e) && e.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

// What's wrong with `raw` (what's in an option's field) for `option`, or null. Empty is fine
// here (required options are checked by missingOptions).
export function optionProblem(option, raw) {
  if (raw == null || raw === '') return null;
  if (option.type === OPTION.INTEGER || option.type === OPTION.NUMBER) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return t('commands.mode.notNumber');
    if (option.type === OPTION.INTEGER && !Number.isInteger(n)) return t('commands.mode.notWhole');
    if (option.min_value != null && n < option.min_value) return t('commands.mode.tooSmall', { min: option.min_value });
    if (option.max_value != null && n > option.max_value) return t('commands.mode.tooBig', { max: option.max_value });
  }
  if (option.type === OPTION.STRING && !option.choices?.length && !option.autocomplete) {
    const length = String(raw).length;
    if (option.min_length != null && length < option.min_length) return t('commands.mode.tooShort', { min: option.min_length });
    if (option.max_length != null && length > option.max_length) return t('commands.mode.tooLong', { max: option.max_length });
  }
  return null;
}

// The required options with nothing filled in.
export function missingOptions(options, values) {
  return options.filter((o) => o.required && (values[o.name] == null || values[o.name] === ''));
}

// One option's value as Discord sends it, from its field: numbers as numbers, booleans as
// booleans, mentions as ids (strings), an attachment as its file's index.
function coerce(option, raw) {
  switch (option.type) {
    case OPTION.INTEGER:
    case OPTION.NUMBER:
      return Number(raw);
    case OPTION.BOOLEAN:
      return raw === true || raw === 'true';
    default:
      return String(raw);
  }
}

// Discord's `options` for `entry` with `values` ({ [option name]: field value }), nested under
// its subcommand (and group). `focused` names the option being typed (autocomplete): it's sent
// as typed, flagged `focused`. Attachment options' values are the index of their file in the
// returned `files` ({ [n]: File }).
export function buildOptions(entry, values, { focused = null } = {}) {
  const files = {};
  const leaf = [];
  for (const option of entry.options) {
    const raw = values[option.name];
    if (option.name === focused) {
      leaf.push({ name: option.name, type: option.type, value: String(raw ?? ''), focused: true });
      continue;
    }
    if (raw == null || raw === '') continue;
    if (option.type === OPTION.ATTACHMENT) {
      const n = Object.keys(files).length;
      files[n] = raw;
      leaf.push({ name: option.name, type: option.type, value: n });
      continue;
    }
    leaf.push({ name: option.name, type: option.type, value: coerce(option, raw) });
  }
  let options = leaf;
  const path = entry.path;
  if (path.length === 1) options = [{ name: path[0], type: OPTION.SUB_COMMAND, options: leaf }];
  if (path.length === 2) {
    options = [{ name: path[0], type: OPTION.SUB_COMMAND_GROUP, options: [{ name: path[1], type: OPTION.SUB_COMMAND, options: leaf }] }];
  }
  return { options, files };
}

// Discord's channel types for our channels, for channel options' `channel_types`.
const DISCORD_CHANNEL_TYPE = { text: 0, voice: 2, thread: 11 };

// The channels a channel option may name (text and voice channels; `channel_types` narrows).
export function channelsFor(option, channels) {
  return (channels ?? []).filter((c) => {
    const type = DISCORD_CHANNEL_TYPE[c.type];
    if (type == null) return false;
    return !option.channel_types?.length || option.channel_types.includes(type);
  });
}

// The message an interaction failed with: the bot not answering in time gets its own words.
export function interactionError(err) {
  if (err?.response?.status === 504) return t('commands.errors.noResponse');
  return err?.response?.data?.error || err?.message || t('commands.errors.failed');
}
