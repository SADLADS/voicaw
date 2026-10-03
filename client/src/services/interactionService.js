import api from '../utils/api';

// Bots' commands and components (server/routes/interactions.js, docs/bots.md). Each call waits
// for the bot (up to 3 seconds on the server) and resolves to { ok } (its messages come by
// socket), { modal } (a form to show: showBotModal) or { choices } (autocomplete). A bot that
// didn't answer is an error (504, "The application did not respond").

// The commands of the channel's guild's bots the person may use there ("/" picker, Apps menus):
// [{ id, application_id, type (1 slash, 2 user, 3 message), name, description, options, bot }].
export async function fetchCommands(channelId) {
  return (await api.get(`/channels/${channelId}/commands`)).data;
}

// Uses command `commandId` with `options` (Discord's shape: [{ name, type, value, options? }]),
// or a context-menu command on `targetId`. `files` ({ [n]: File }) are attachment options' files
// (the option's value is n).
export async function runCommand(channelId, { commandId, options, targetId, files }) {
  const body = { command_id: commandId, ...(options ? { options } : {}), ...(targetId != null ? { target_id: String(targetId) } : {}) };
  const entries = Object.entries(files ?? {});
  if (!entries.length) return (await api.post(`/channels/${channelId}/command-interactions`, body)).data;
  const form = new FormData();
  form.append('payload_json', JSON.stringify(body));
  for (const [n, file] of entries) form.append(`files[${n}]`, file, file.name);
  return (await api.post(`/channels/${channelId}/command-interactions`, form)).data;
}

// Suggestions for the focused option (`options` with one `focused: true`): [{ name, value }].
export async function autocomplete(channelId, commandId, options) {
  return (await api.post(`/channels/${channelId}/autocomplete`, { command_id: commandId, options })).data.choices ?? [];
}

// A button clicked (`values` undefined) or a select's choice on message `messageId`.
export async function useComponent(messageId, customId, values) {
  return (await api.post(`/guild-messages/${messageId}/component-interactions`, { custom_id: customId, ...(values ? { values } : {}) })).data;
}

// Submits form `modalId` with `answers` ({ [custom_id]: text or [values] }).
export async function submitModal(modalId, answers) {
  return (await api.post(`/modals/${modalId}`, { answers })).data;
}

// Tells the server an ephemeral message was dismissed (it forgets it).
export async function dismissEphemeral(messageId) {
  await api.delete(`/ephemeral-messages/${messageId}`).catch(() => {});
}

// ---- The bot form being shown (one at a time), for BotModal ----

let shownModal = null;
const listeners = new Set();

export function showBotModal(modal) {
  shownModal = modal;
  listeners.forEach((listener) => listener(shownModal));
}

export function closeBotModal() {
  showBotModal(null);
}

export function onBotModal(listener) {
  listeners.add(listener);
  listener(shownModal);
  return () => listeners.delete(listener);
}

// Shows what a command, component or form gave back: a form opens; anything else is done.
export function handleInteractionResult(result) {
  if (result?.modal) showBotModal(result.modal);
  return result;
}
