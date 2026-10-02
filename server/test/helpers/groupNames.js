import { importGroupKey, openGroupName, sealGroupName, signGroupName } from '../../../client/src/services/groupCrypto.js';

// A group's name as the app sends it with an epoch or a rename: signed by `signer` (a test
// user with `signingKey`), encrypted with the epoch key `keyBytes` (raw) or `key` (CryptoKey).
export async function sealName(signer, groupId, epoch, { keyBytes, key, name = '', version = 1, initial = version === 1 }) {
  const signed = await signGroupName({ groupId, version, renamerId: signer.id, name, initial }, signer.signingKey);
  return sealGroupName(signed, key ?? await importGroupKey(keyBytes), groupId, epoch);
}

// Opens `envelope` with `key`, checking the renamer against the group's users (GET /group-dms/:id).
export function openName(envelope, key, groupId, epoch, users) {
  return openGroupName(envelope, key, groupId, epoch, (id) => users.find((u) => u.id === id)?.identity_key);
}
