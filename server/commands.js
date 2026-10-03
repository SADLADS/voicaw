const db = require('./db');
const { has, PERMISSIONS } = require('./permissions');
const { fromDiscordPermissions, toDiscordPermissions } = require('./discord');

// Application commands (docs/bots.md): a bot's slash commands (type 1, "chat input") and
// right-click commands on a user (2) or a message (3), Discord's shape and limits
// (https://discord.com/developers/docs/interactions/application-commands). Global ones (guild
// 0) show in every guild the bot is in; guild ones only there. Bots make them with the bot API
// (routes/botApi.js); people see the ones they may use (GET /guilds/:id/commands) and use them
// through interactions (interactions.js). Commands only exist in guilds (no DMs on Voicaw).

const TYPES = { CHAT_INPUT: 1, USER: 2, MESSAGE: 3 };
const OPTION = {
  SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7,
  ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11,
};
// Per application, everywhere or per guild, as in Discord.
const LIMITS = { [TYPES.CHAT_INPUT]: 100, [TYPES.USER]: 5, [TYPES.MESSAGE]: 5 };
const MAX_OPTIONS = 25;
const MAX_CHOICES = 25;
const MAX_TOTAL_LENGTH = 8000; // names, descriptions and choice values of one command
const CHAT_NAME = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
const INT_LIMIT = 2 ** 53;

const now = () => Math.floor(Date.now() / 1000);

// A 50035 error for one field (routes/webhooks.js's FormError: the bot API answers it Discord's way).
function formError(path, message, code = 'BASE_TYPE_INVALID') {
  const { FormError } = require('./routes/webhooks');
  return new FormError(path, message, code);
}

function cleanLocalizations(value, path) {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw formError(path, 'Must be an object.', 'MODEL_TYPE_CONVERT');
  return value;
}

function cleanName(value, path, type = TYPES.CHAT_INPUT) {
  if (typeof value !== 'string' || !value) throw formError(path, 'This field is required', 'BASE_TYPE_REQUIRED');
  if (type === TYPES.CHAT_INPUT) {
    if (!CHAT_NAME.test(value) || value !== value.toLowerCase()) throw formError(path, 'Command name is invalid', 'APPLICATION_COMMAND_INVALID_NAME');
  } else if (value.length > 32 || !value.trim()) {
    throw formError(path, 'Must be between 1 and 32 in length.', 'BASE_TYPE_BAD_LENGTH');
  }
  return value;
}

function cleanDescription(value, path, required) {
  if (!required) {
    if (value != null && value !== '') throw formError(path, 'Context menu commands cannot have a description', 'APPLICATION_COMMAND_INVALID_DESCRIPTION');
    return '';
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    throw formError(path, 'Must be between 1 and 100 in length.', 'BASE_TYPE_BAD_LENGTH');
  }
  return value;
}

function cleanNumber(value, path, integer) {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || Math.abs(value) > INT_LIMIT) {
    throw formError(path, integer ? 'Value is not int.' : 'Value is not number.', 'NUMBER_TYPE_COERCE');
  }
  return value;
}

// One option (and, for subcommands and groups, theirs), checked and cut to what we keep.
function cleanOption(raw, path, depth) {
  if (!raw || typeof raw !== 'object') throw formError(path, 'Must be an object.', 'MODEL_TYPE_CONVERT');
  const type = raw.type;
  if (!Object.values(OPTION).includes(type)) throw formError([...path, 'type'], `Value "${type}" is not a valid enum value.`, 'BASE_TYPE_CHOICES');
  const option = {
    type,
    name: cleanName(raw.name, [...path, 'name']),
    description: cleanDescription(raw.description, [...path, 'description'], true),
  };
  const nameLocalizations = cleanLocalizations(raw.name_localizations, [...path, 'name_localizations']);
  const descriptionLocalizations = cleanLocalizations(raw.description_localizations, [...path, 'description_localizations']);
  if (nameLocalizations) option.name_localizations = nameLocalizations;
  if (descriptionLocalizations) option.description_localizations = descriptionLocalizations;

  if (type === OPTION.SUB_COMMAND || type === OPTION.SUB_COMMAND_GROUP) {
    // Groups hold subcommands; subcommands hold plain options; neither nests further.
    if (depth >= (type === OPTION.SUB_COMMAND_GROUP ? 1 : 2)) throw formError([...path, 'type'], 'Subcommands cannot be nested this deep.', 'APPLICATION_COMMAND_OPTIONS_TYPE_INVALID');
    option.options = cleanOptions(raw.options, [...path, 'options'], depth + 1, type === OPTION.SUB_COMMAND_GROUP ? 'group' : 'subcommand');
    return option;
  }

  option.required = Boolean(raw.required);
  const choicesAllowed = [OPTION.STRING, OPTION.INTEGER, OPTION.NUMBER].includes(type);
  if (raw.choices != null && (!Array.isArray(raw.choices) || raw.choices.length)) {
    if (!choicesAllowed) throw formError([...path, 'choices'], 'Choices are only for strings, integers and numbers.', 'APPLICATION_COMMAND_OPTION_CHOICES_INVALID');
    if (!Array.isArray(raw.choices) || raw.choices.length > MAX_CHOICES) throw formError([...path, 'choices'], `Must be ${MAX_CHOICES} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
    option.choices = raw.choices.map((c, i) => {
      const at = [...path, 'choices', i];
      if (typeof c?.name !== 'string' || c.name.length < 1 || c.name.length > 100) throw formError([...at, 'name'], 'Must be between 1 and 100 in length.', 'BASE_TYPE_BAD_LENGTH');
      const value = type === OPTION.STRING ? c.value : cleanNumber(c.value, [...at, 'value'], type === OPTION.INTEGER);
      if (type === OPTION.STRING && (typeof value !== 'string' || value.length < 1 || value.length > 100)) {
        throw formError([...at, 'value'], 'Must be between 1 and 100 in length.', 'BASE_TYPE_BAD_LENGTH');
      }
      return { name: c.name, value, ...(c.name_localizations ? { name_localizations: c.name_localizations } : {}) };
    });
  }
  if (raw.autocomplete) {
    if (!choicesAllowed) throw formError([...path, 'autocomplete'], 'Autocomplete is only for strings, integers and numbers.', 'APPLICATION_COMMAND_OPTION_AUTOCOMPLETE_INVALID');
    if (option.choices) throw formError([...path, 'autocomplete'], 'Autocomplete cannot be used with choices.', 'APPLICATION_COMMAND_OPTION_AUTOCOMPLETE_INVALID');
    option.autocomplete = true;
  }
  if (type === OPTION.INTEGER || type === OPTION.NUMBER) {
    const min = cleanNumber(raw.min_value, [...path, 'min_value'], type === OPTION.INTEGER);
    const max = cleanNumber(raw.max_value, [...path, 'max_value'], type === OPTION.INTEGER);
    if (min !== undefined) option.min_value = min;
    if (max !== undefined) option.max_value = max;
    if (min !== undefined && max !== undefined && min > max) throw formError([...path, 'min_value'], 'Must be less than or equal to max_value.', 'NUMBER_TYPE_MAX');
  }
  if (type === OPTION.STRING) {
    for (const key of ['min_length', 'max_length']) {
      if (raw[key] == null) continue;
      const n = raw[key];
      if (!Number.isInteger(n) || n < (key === 'min_length' ? 0 : 1) || n > 6000) throw formError([...path, key], 'Must be between 0 and 6000.', 'NUMBER_TYPE_MAX');
      option[key] = n;
    }
  }
  if (type === OPTION.CHANNEL && Array.isArray(raw.channel_types)) option.channel_types = raw.channel_types.filter(Number.isInteger);
  return option;
}

// A list of options: names unique, required ones first, subcommands not mixed with plain ones.
function cleanOptions(raw, path, depth = 0, within = 'command') {
  if (raw == null) {
    if (within === 'group') throw formError(path, 'Subcommand groups need subcommands.', 'APPLICATION_COMMAND_OPTIONS_TYPE_INVALID');
    return [];
  }
  if (!Array.isArray(raw)) throw formError(path, 'Must be an array.', 'BASE_TYPE_ARRAY');
  if (raw.length > MAX_OPTIONS) throw formError(path, `Must be ${MAX_OPTIONS} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
  const options = raw.map((o, i) => cleanOption(o, [...path, i], depth));
  const names = new Set();
  for (const [i, o] of options.entries()) {
    if (names.has(o.name)) throw formError([...path, i, 'name'], 'Application command option names must be unique', 'APPLICATION_COMMAND_OPTIONS_NAME_ALREADY_EXISTS');
    names.add(o.name);
  }
  const nested = (o) => o.type === OPTION.SUB_COMMAND || o.type === OPTION.SUB_COMMAND_GROUP;
  if (within === 'group' && options.some((o) => o.type !== OPTION.SUB_COMMAND)) {
    throw formError(path, 'Subcommand groups can only hold subcommands.', 'APPLICATION_COMMAND_OPTIONS_TYPE_INVALID');
  }
  if (options.some(nested) && !options.every(nested)) {
    throw formError(path, 'Subcommands cannot be mixed with other options.', 'APPLICATION_COMMAND_OPTIONS_TYPE_INVALID');
  }
  let optionalSeen = false;
  for (const [i, o] of options.entries()) {
    if (nested(o)) continue;
    if (!o.required) optionalSeen = true;
    else if (optionalSeen) throw formError([...path, i, 'required'], 'Required options must be placed before non-required options', 'APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID');
  }
  return options;
}

const textLength = (options = []) => options.reduce((sum, o) => sum + o.name.length + o.description.length +
  (o.choices ?? []).reduce((s, c) => s + c.name.length + String(c.value).length, 0) + textLength(o.options), 0);

// A command body from the bot API, checked: { type, name, description, options, localizations,
// default_member_permissions (our bits or null), nsfw }. `base` is the command it changes (PATCH).
function cleanCommand(raw, base = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw formError([], 'Must be an object.', 'MODEL_TYPE_CONVERT');
  const merged = base ? { ...base, ...raw } : raw;
  const type = merged.type ?? TYPES.CHAT_INPUT;
  if (!Object.values(TYPES).includes(type)) throw formError(['type'], `Value "${type}" is not a valid enum value.`, 'BASE_TYPE_CHOICES');
  if (base && raw.type !== undefined && raw.type !== base.type) throw formError(['type'], "A command's type can't change.", 'BASE_TYPE_INVALID');
  const chat = type === TYPES.CHAT_INPUT;
  const command = {
    type,
    name: cleanName(merged.name, ['name'], type),
    description: cleanDescription(merged.description, ['description'], chat),
    options: chat ? cleanOptions(merged.options, ['options']) : [],
    nsfw: Boolean(merged.nsfw),
  };
  if (!chat && merged.options?.length) throw formError(['options'], 'Context menu commands cannot have options', 'APPLICATION_COMMAND_OPTIONS_TYPE_INVALID');
  const localizations = {};
  for (const key of ['name_localizations', 'description_localizations']) {
    const value = cleanLocalizations(merged[key], [key]);
    if (value) localizations[key] = value;
  }
  command.localizations = localizations;
  const perms = merged.default_member_permissions;
  if (perms === null || perms === undefined) {
    command.default_member_permissions = null;
  } else {
    try {
      // "0": only administrators (Discord's meaning), kept as ADMINISTRATOR.
      const bits = fromDiscordPermissions(perms);
      command.default_member_permissions = String(perms) === '0' ? PERMISSIONS.ADMINISTRATOR : bits;
    } catch {
      throw formError(['default_member_permissions'], 'Invalid permissions.', 'BASE_TYPE_INVALID');
    }
  }
  if (textLength(command.options) + command.name.length + command.description.length > MAX_TOTAL_LENGTH) {
    throw formError([], 'Command exceeds maximum size (8000)', 'APPLICATION_COMMAND_TOO_LARGE');
  }
  return command;
}

// ---- Rows and Discord objects ----

function parse(json, fallback) {
  try {
    return json ? JSON.parse(json) : fallback;
  } catch {
    return fallback;
  }
}

function commandObject(row) {
  const localizations = parse(row.localizations, {});
  return {
    id: String(row.id),
    type: row.type,
    application_id: String(row.application_id),
    ...(row.guild_id ? { guild_id: String(row.guild_id) } : {}),
    name: row.name,
    name_localizations: localizations.name_localizations ?? null,
    description: row.description,
    description_localizations: localizations.description_localizations ?? null,
    ...(row.type === TYPES.CHAT_INPUT ? { options: parse(row.options, []) } : {}),
    default_member_permissions: row.default_member_permissions == null
      ? null
      : row.default_member_permissions === PERMISSIONS.ADMINISTRATOR ? '0' : toDiscordPermissions(row.default_member_permissions),
    dm_permission: false,
    contexts: [0],
    integration_types: [0],
    nsfw: Boolean(row.nsfw),
    version: String(row.version),
  };
}

// The command as the app's picker needs it (our ids and bits; the bot's name and picture).
function pickerObject(row) {
  return {
    id: row.id,
    application_id: row.application_id,
    guild_id: row.guild_id || null,
    type: row.type,
    name: row.name,
    description: row.description,
    options: parse(row.options, []),
    nsfw: Boolean(row.nsfw),
    bot: { id: row.application_id, name: row.bot_name, avatar: row.bot_avatar },
  };
}

// ---- Storage ----

const listCommands = (applicationId, guildId = 0) => db.all(
  'SELECT * FROM bot_commands WHERE application_id = ? AND guild_id = ? ORDER BY id',
  [applicationId, guildId]
);

const getCommand = (applicationId, guildId, id) => db.get(
  'SELECT * FROM bot_commands WHERE application_id = ? AND guild_id = ? AND id = ?',
  [applicationId, guildId, id]
);

function checkLimit(existing, type) {
  if (existing.filter((c) => c.type === type).length >= LIMITS[type]) {
    const { ActionError } = require('./actionError');
    throw new ActionError(400, `Maximum number of application commands reached (${LIMITS[type]})`, 30032);
  }
}

// Creates `command` (cleanCommand's), or replaces the one with its type and name (as Discord's
// POST does). Resolves to { row, created }.
async function saveCommand(applicationId, guildId, command) {
  return db.transaction(async () => {
    const existing = await listCommands(applicationId, guildId);
    const same = existing.find((c) => c.type === command.type && c.name === command.name);
    if (!same) checkLimit(existing, command.type);
    const values = [command.description, JSON.stringify(command.options), JSON.stringify(command.localizations),
      command.default_member_permissions, command.nsfw ? 1 : 0, Date.now()];
    if (same) {
      await db.run(
        'UPDATE bot_commands SET description = ?, options = ?, localizations = ?, default_member_permissions = ?, nsfw = ?, version = ? WHERE id = ?',
        [...values, same.id]
      );
      return { row: await db.get('SELECT * FROM bot_commands WHERE id = ?', [same.id]), created: false };
    }
    const { lastID } = await db.run(
      `INSERT INTO bot_commands (description, options, localizations, default_member_permissions, nsfw, version, application_id, guild_id, type, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, applicationId, guildId, command.type, command.name, now()]
    );
    return { row: await db.get('SELECT * FROM bot_commands WHERE id = ?', [lastID]), created: true };
  });
}

// Changes command `row` to `command` (cleanCommand's with the row as base).
async function updateCommand(row, command) {
  await db.transaction(async () => {
    const clash = await db.get(
      'SELECT id FROM bot_commands WHERE application_id = ? AND guild_id = ? AND type = ? AND name = ? AND id != ?',
      [row.application_id, row.guild_id, command.type, command.name, row.id]
    );
    if (clash) throw formError(['name'], 'Application command names must be unique', 'APPLICATION_COMMANDS_DUPLICATE_NAME');
    await db.run(
      'UPDATE bot_commands SET name = ?, description = ?, options = ?, localizations = ?, default_member_permissions = ?, nsfw = ?, version = ? WHERE id = ?',
      [command.name, command.description, JSON.stringify(command.options), JSON.stringify(command.localizations),
        command.default_member_permissions, command.nsfw ? 1 : 0, Date.now(), row.id]
    );
  });
  return db.get('SELECT * FROM bot_commands WHERE id = ?', [row.id]);
}

// Discord's bulk overwrite (PUT): the commands become exactly `commands` (cleaned), keeping the
// ids of those with the same type and name (or id) as before. Resolves to the rows.
async function overwriteCommands(applicationId, guildId, rawList) {
  const { ActionError } = require('./actionError');
  if (!Array.isArray(rawList)) throw formError([], 'Must be an array.', 'BASE_TYPE_ARRAY');
  const commands = rawList.map((raw, i) => {
    try {
      return { ...cleanCommand(raw), id: raw.id };
    } catch (err) {
      if (err.path) err.path = [i, ...err.path];
      throw err;
    }
  });
  for (const type of Object.values(TYPES)) {
    if (commands.filter((c) => c.type === type).length > LIMITS[type]) {
      throw new ActionError(400, `Maximum number of application commands reached (${LIMITS[type]})`, 30032);
    }
  }
  const keys = new Set();
  for (const [i, c] of commands.entries()) {
    const key = `${c.type}:${c.name}`;
    if (keys.has(key)) throw formError([i, 'name'], 'Application command names must be unique', 'APPLICATION_COMMANDS_DUPLICATE_NAME');
    keys.add(key);
  }
  return db.transaction(async () => {
    const existing = await listCommands(applicationId, guildId);
    const kept = new Set();
    const ids = [];
    for (const command of commands) {
      const same = existing.find((c) => (command.id != null && String(c.id) === String(command.id)) || (c.type === command.type && c.name === command.name));
      if (same && !kept.has(same.id)) {
        kept.add(same.id);
        await db.run(
          'UPDATE bot_commands SET type = ?, name = ?, description = ?, options = ?, localizations = ?, default_member_permissions = ?, nsfw = ?, version = ? WHERE id = ?',
          [command.type, `\u0000${same.id}`, command.description, JSON.stringify(command.options), JSON.stringify(command.localizations),
            command.default_member_permissions, command.nsfw ? 1 : 0, Date.now(), same.id]
        );
        ids.push([same.id, command.name]);
      } else {
        ids.push([null, command]);
      }
    }
    for (const row of existing) if (!kept.has(row.id)) await db.run('DELETE FROM bot_commands WHERE id = ?', [row.id]);
    // Names go in last (a placeholder above), so swapping two commands' names can't clash.
    const result = [];
    for (const [id, value] of ids) {
      if (id) {
        await db.run('UPDATE bot_commands SET name = ? WHERE id = ?', [value, id]);
        result.push(id);
      } else {
        const c = value;
        const { lastID } = await db.run(
          `INSERT INTO bot_commands (application_id, guild_id, type, name, description, options, localizations, default_member_permissions, nsfw, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [applicationId, guildId, c.type, c.name, c.description, JSON.stringify(c.options), JSON.stringify(c.localizations),
            c.default_member_permissions, c.nsfw ? 1 : 0, Date.now(), now()]
        );
        result.push(lastID);
      }
    }
    return Promise.all(result.map((id) => db.get('SELECT * FROM bot_commands WHERE id = ?', [id])));
  });
}

const deleteCommand = (row) => db.run('DELETE FROM bot_commands WHERE id = ?', [row.id]);

// Whether `member` (a member context, guilds.js) with `channelPermissions` in the channel may use
// command `row`: Send Messages there (Discord's Use Application Commands), its default member
// permissions (all of them; administrators always), and an NSFW command only in an NSFW channel.
function mayUse(row, member, channelPermissions, channel) {
  if (!has(channelPermissions, PERMISSIONS.SEND_MESSAGES)) return false;
  if (row.nsfw && !channel.nsfw) return false;
  if (row.default_member_permissions == null) return true;
  if (has(member.permissions, PERMISSIONS.ADMINISTRATOR)) return true;
  if (row.default_member_permissions === PERMISSIONS.ADMINISTRATOR) return false;
  return has(channelPermissions, row.default_member_permissions);
}

// Every command of the guild's bots (theirs everywhere and the guild's own), with the bot's
// name and picture; a guild command shadows a global one of the same type and name.
async function guildCommands(guildId) {
  const rows = await db.all(
    `SELECT c.*, COALESCE(u.display_name, u.username) AS bot_name, u.avatar AS bot_avatar
     FROM bot_commands c
     JOIN guild_members gm ON gm.user_id = c.application_id AND gm.guild_id = ?
     JOIN users u ON u.id = c.application_id
     WHERE c.guild_id IN (0, ?) ORDER BY c.application_id, c.guild_id DESC, c.name`,
    [guildId, guildId]
  );
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.application_id}:${r.type}:${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  TYPES,
  OPTION,
  LIMITS,
  cleanCommand,
  commandObject,
  pickerObject,
  listCommands,
  getCommand,
  saveCommand,
  updateCommand,
  overwriteCommands,
  deleteCommand,
  mayUse,
  guildCommands,
  parse,
};
