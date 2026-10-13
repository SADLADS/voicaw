import api from '../utils/api';
import { t } from '../i18n';

// Must match MAX_AVATAR_UPLOAD_BYTES in server/avatarImage.js (pictures and banners).
export const MAX_PROFILE_PIC_BYTES = 8 * 1024 * 1024;

// Why a picked picture or banner can't be used (shown as is), or null.
export function pictureFileError(file) {
  if (!file.type.startsWith('image/')) return t('settings.profile.onlyImages');
  if (file.size > MAX_PROFILE_PIC_BYTES) return t('settings.profile.tooLarge');
  return null;
}

// Sets a new profile picture: the original goes straight to the object store (through a URL
// the server signs for this file's type and size), then the server crops and shrinks it and
// tells everyone (server/avatars.js), keeping `crop` (from ImageCropper; optional: the middle).
// Resolves to your profile (with its new `avatar`). (Profile pictures aren't encrypted.)
export async function uploadProfilePicture(file, crop, kind = 'avatar') {
  const { data } = await api.post(`/profile/${kind}`, { type: file.type, size: file.size });
  if (!data?.url) throw new Error(t('app.profile.invalidUploadUrl'));

  const res = await fetch(data.url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(t('app.profile.uploadFailed'));
  return (await api.post(`/profile/${kind}/${data.uploadId}/ready`, crop ? { crop } : {})).data;
}

// The same for your banner (a 5:2 crop, server/avatarImage.js processBanner).
export const uploadBanner = (file, crop) => uploadProfilePicture(file, crop, 'banner');
export const removeBanner = async () => (await api.delete('/profile/banner')).data;

// Someone's profile's tabs (server/routes/userProfiles.js): { memberSince, activity,
// mutualFriends, mutualGuilds, hidden? }, each null when they hide it.
export async function fetchUserProfile(userId) {
  return (await api.get(`/users/${userId}/profile`)).data;
}

// Back to the default picture. Resolves to your profile.
export async function removeProfilePicture() {
  return (await api.delete('/profile/avatar')).data;
}

// Saves your profile: any of { displayName, customStatus, customStatusEmoji, bio } (null or "" clears one),
// `bannerColor` (0xRRGGBB or null).
// Resolves to the saved profile ({ id, username, display_name, custom_status, custom_status_emoji, bio }).
export async function updateProfile(changes) {
  return (await api.put('/profile', changes)).data;
}
