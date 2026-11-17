import api from '../../utils/api';

// The history import API (server/routes/guildImports.js).

const base = (guildId) => `/guilds/${guildId}/imports`;

export const listImports = async (guildId) => (await api.get(base(guildId))).data;
export const getImport = async (guildId, importId) => (await api.get(`${base(guildId)}/${importId}`)).data;
export const createImport = async (guildId, body) => (await api.post(base(guildId), body)).data;
export const setMapping = async (guildId, importId, body) => (await api.put(`${base(guildId)}/${importId}/mapping`, body)).data;
export const addMessages = async (guildId, importId, body) => (await api.post(`${base(guildId)}/${importId}/messages`, body)).data;
export const knownMessages = async (guildId, importId, sourceIds) => (await api.post(`${base(guildId)}/${importId}/known`, { sourceIds })).data.known;
export const finishImport = async (guildId, importId) => (await api.post(`${base(guildId)}/${importId}/finish`)).data;
export const deleteImport = async (guildId, importId) => { await api.delete(`${base(guildId)}/${importId}`); };

// A file of the archive: a signed upload address from the server, then the file straight to
// the object store (as attachments go, utils/uploads). -> the attachment a batch gives back.
export async function uploadFile(guildId, importId, blob, { name, width, height }) {
  const { uploadUrl, attachment } = (await api.post(`${base(guildId)}/${importId}/files`, { name, size: blob.size, width, height })).data;
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': attachment.content_type }, body: blob });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return attachment;
}

// An author's picture from the archive (the server makes it a profile picture's size).
export async function uploadAuthorAvatar(guildId, importId, authorId, blob) {
  return (await api.put(`${base(guildId)}/${importId}/authors/${authorId}/avatar`, blob, {
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  })).data;
}

// ---- The person linked (Settings → Privacy, "This wasn't me") ----

export const linkedToMe = async () => (await api.get('/guild-imports/me')).data;
export const unlinkAll = async () => (await api.post('/guild-imports/me/unlink-all')).data;
export const unlinkImportedAuthor = async (authorId) => (await api.post(`/guild-imports/authors/${authorId}/unlink`)).data;
