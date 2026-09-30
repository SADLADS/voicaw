import api from '../utils/api';

// Must match MAX_PROFILE_PIC_BYTES in server/routes/uploads.js.
export const MAX_PROFILE_PIC_BYTES = 8 * 1024 * 1024;

// Uploads a new profile picture straight to the object store, through a pre-signed URL the
// server signs for this file's type and size. (Profile pictures aren't encrypted.)
export async function uploadProfilePicture(file) {
  const { data } = await api.get('/upload_profile_pic', {
    params: { type: file.type, size: file.size },
  });
  if (!data?.url) throw new Error('Invalid upload URL');

  const res = await fetch(data.url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error('Upload failed');
}

// Saves your profile: any of { displayName, customStatus, bio } (null or "" clears one).
// Resolves to the saved profile ({ id, username, display_name, custom_status, bio }).
export async function updateProfile(changes) {
  return (await api.put('/profile', changes)).data;
}
