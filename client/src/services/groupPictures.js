import { decryptGroupPicture } from './groupCrypto';
import { fetchGroupPicture } from './groupService';

// Group pictures as the page shows them: fetched (encrypted), decrypted with the key from the
// group's checked name record, and kept as blob URLs for as long as the page is open. A new
// picture has a new id, so one never goes stale.
const urls = new Map(); // picture id -> Promise of a blob URL

// -> a Promise of the picture's blob URL. Rejects if it can't be fetched or doesn't decrypt
// (then it's tried again next time).
export function groupPictureUrl(groupId, picture) {
  let url = urls.get(picture.id);
  if (!url) {
    url = fetchGroupPicture(groupId, picture.id)
      .then((data) => decryptGroupPicture(data, picture, groupId))
      .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: 'image/webp' })));
    url.catch(() => urls.delete(picture.id));
    urls.set(picture.id, url);
  }
  return url;
}
