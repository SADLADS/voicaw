import api from '../utils/api';
import { shareOrigin } from '../utils/guildDisplay';
import { mergeProfiles } from '../utils/profiles';

// Puts applications' bots (and anyone given as `users`) in the profile store, so Avatar and
// displayName draw them on pages outside the app's layout.
export function rememberBots(apps, users = []) {
  mergeProfiles([
    ...apps.filter((a) => a?.bot).map((a) => ({
      id: a.bot.id, username: `${a.bot.username}#${a.bot.discriminator}`, display_name: a.name, avatar: a.bot.avatar,
    })),
    ...users.filter(Boolean),
  ]);
}

// The developer portal's applications (bots) and adding a bot to a guild (server/routes/
// applications.js; docs/bots.md).

export const fetchApplications = async () => (await api.get('/applications')).data;
export const fetchApplication = async (id) => (await api.get(`/applications/${id}`)).data;
// The new application, with its bot's `token` (shown this once).
export const createApplication = async (name) => (await api.post('/applications', { name })).data;
// `changes`: name, description, public, avatar (a data URI, or null for the default picture).
export const updateApplication = async (id, changes) => (await api.patch(`/applications/${id}`, changes)).data;
export const deleteApplication = (id) => api.delete(`/applications/${id}`);
// A new token (the old one stops working): { token }.
export const resetToken = async (id) => (await api.post(`/applications/${id}/token`)).data;
export const removeFromGuild = (id, guildId) => api.delete(`/applications/${id}/guilds/${guildId}`);

// The bot, who made it and the guilds you could add it to.
export const fetchAuthorization = async (clientId) => (await api.get('/oauth2/authorize', { params: { client_id: clientId } })).data;
// `permissions`: Discord's bitfield (a decimal string).
export const authorize = async ({ clientId, guildId, permissions }) => (
  await api.post('/oauth2/authorize', { client_id: clientId, guild_id: guildId, permissions })
).data;

// The link that adds bot `id` to a guild, as Discord's: /oauth2/authorize?client_id=…&scope=bot&permissions=….
export function inviteLink(id, permissions) {
  return `${shareOrigin()}/oauth2/authorize?client_id=${id}&scope=bot&permissions=${permissions}`;
}

export const DOCS_URL = 'https://voicaw.com/developers/docs/';
