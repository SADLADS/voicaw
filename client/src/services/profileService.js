import api from '../utils/api';
import { t } from '../i18n';

// Must match MAX_PROFILE_PIC_BYTES in server/routes/uploads.js.
export const MAX_PROFILE_PIC_BYTES = 8 * 1024 * 1024;

// Sets a new profile picture: the original goes straight to the object store (through a URL
// the server signs for this file's type and size), then the server crops and shrinks it and
// tells everyone (server/avatars.js). Resolves to your profile (with its new `avatar`).
// (Profile pictures aren't encrypted.)
export async function uploadProfilePicture(file) {
  const { data } = await api.post('/profile/avatar', { type: file.type, size: file.size });
  if (!data?.url) throw new Error(t('app.profile.invalidUploadUrl'));

  const res = await fetch(data.url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(t('app.profile.uploadFailed'));
  return (await api.post(`/profile/avatar/${data.uploadId}/ready`)).data;
}

// Back to the default picture. Resolves to your profile.
export async function removeProfilePicture() {
  return (await api.delete('/profile/avatar')).data;
}

// Saves your profile: any of { displayName, customStatus, bio } (null or "" clears one).
// Resolves to the saved profile ({ id, username, display_name, custom_status, bio }).
export async function updateProfile(changes) {
  return (await api.put('/profile', changes)).data;
}
