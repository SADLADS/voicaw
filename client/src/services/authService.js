import api from '../utils/api';
import {
  generateUserKeys, wrapKeyBackup, unwrapKeyBackup, generateRecoveryCode, normalizeRecoveryCode, recoveryAuth,
  recoveryVerifier, wrapRecoveryBackup, unwrapRecoveryBackup,
} from './encryptionService';
import { storeUserKeys } from './keyStore';
import { fetchGroups } from './groupService';
import { leaveEntry } from './groupKeys';
import { t } from '../i18n';

// Logging in and registering: OPAQUE (the password never leaves the device) plus the
// encryption keys, which the server keeps only as a backup encrypted with OPAQUE's
// exportKey (and optionally a second one encrypted with a recovery code). On success the
// keys go into this device's key store and the token into localStorage. Changing the
// password or recovering the account re-encrypts the backup here, so the server never
// sees a password or a private key. (server/test/helpers/authFlow.js mirrors this protocol.)

// The password is what the encryption keys are protected with, so insist on a reasonable
// length. The server never sees it, so it can only be checked here.
export const MIN_PASSWORD_LENGTH = 10;

const PUBLIC_KEY_FIELDS = ['identityKey', 'encryptionKey', 'encryptionKeySignature'];

// What a suspended account is told (server: 403 `code: 'suspended'`, with the admin's reason).
export function suspendedText(reason) {
  return reason ? t('auth.errors.suspendedBecause', { reason }) : t('auth.errors.suspended');
}

// Sends and resolves to the response body; a refusal throws the server's own message
// (e.g. "Username already exists", or too many attempts).
async function send(method, path, body) {
  try {
    return (await api[method](path, body)).data;
  } catch (err) {
    const data = err.response?.data;
    if (data?.code === 'suspended') throw new Error(suspendedText(data.reason));
    throw new Error(data?.error || err.message);
  }
}

const post = (path, body) => send('post', path, body);

// OPAQUE (with its WebAssembly, ~400 kB) loads the first time it's needed: logging in,
// signing up or checking a password, not with the rest of the app on every start.
let opaqueModule = null;
function loadOpaque() {
  opaqueModule ??= import('@serenity-kit/opaque').then(async (m) => {
    await m.ready;
    return m;
  });
  return opaqueModule;
}

// Resolves to the user ({ token, id, username }); throws an Error with a message to show.
export async function logIn(username, password) {
  if (!username || !password) throw new Error(t('auth.errors.usernameAndPasswordRequired'));

  const opaque = await loadOpaque();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  // clientLoginState is this device's secret half of the OPAQUE exchange: never send it.
  const started = await post('/initiatelogin', { startLoginRequest, userIdentifier: username });
  const loginResult = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: started.loginResponse,
    password,
  });
  // Wrong password and unknown username look the same here (on purpose).
  if (!loginResult) throw new Error(t('auth.errors.incorrectLogin'));
  const { finishLoginRequest, sessionKey, exportKey } = loginResult;

  const data = await post('/finaliselogin', {
    finishLoginRequest,
    clientSessionKey: sessionKey,
    userIdentifier: username,
  });
  const { token, id, keyBackup } = data;
  if (!token || !keyBackup) throw new Error(t('auth.errors.loginFailed'));

  // The keys are encrypted with OPAQUE's exportKey, which only this password produces.
  let keys;
  try {
    keys = await unwrapKeyBackup(exportKey, keyBackup);
  } catch {
    throw new Error(t('auth.errors.keysLocked'));
  }
  // The server must publish exactly the public keys in our own backup; otherwise other
  // people would be encrypting to keys that aren't ours.
  if (PUBLIC_KEY_FIELDS.some((field) => keys.public[field] !== data[field])) {
    throw new Error(t('auth.errors.publicKeysMismatchLogin'));
  }

  await storeUserKeys(id, keys);
  localStorage.setItem('token', token);
  return { token, id, username: data.username, hasRecoveryCode: Boolean(data.hasRecoveryCode), termsAccepted: data.termsAccepted !== false };
}

function checkNewPassword(password) {
  if (!password) throw new Error(t('auth.errors.passwordRequired'));
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(t('auth.errors.passwordTooShort', { count: MIN_PASSWORD_LENGTH }));
  }
}

// OPAQUE registration for `password`: { registrationRecord, exportKey }.
async function registerPassword(username, password) {
  const opaque = await loadOpaque();
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const started = await post('/initiateregister', { userIdentifier: username, registrationRequest });
  if (started.error) throw new Error(started.error);
  return opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.registrationResponse,
    password,
  });
}

// A new password's registration record and the keys encrypted for it. The backup is opened
// again before anything is sent, so a bad one can never replace the working one.
async function newPasswordFields(username, password, keys) {
  const { registrationRecord, exportKey } = await registerPassword(username, password);
  const keyBackup = await wrapKeyBackup(exportKey, keys);
  await unwrapKeyBackup(exportKey, keyBackup);
  return { registrationRecord, keyBackup };
}

// What the server stores for a recovery code: { recoveryVerifier, recoveryBackup }.
async function recoveryFields(code, keys) {
  return {
    recoveryVerifier: await recoveryVerifier(await recoveryAuth(code)),
    recoveryBackup: await wrapRecoveryBackup(code, keys),
  };
}

// Creates the account with new keys and a recovery code. Resolves to { user, recoveryCode }
// (user: the logged-in { token, id, username, hasRecoveryCode }, or null if the server
// registered it without logging in). The code is shown once and never stored.
// `acceptedTerms`: the version of the terms of use the person ticked (/api/config termsVersion).
export async function register(username, password, acceptedTerms) {
  if (!username) throw new Error(t('auth.errors.usernameAndPasswordRequired'));
  checkNewPassword(password);

  const { registrationRecord, exportKey } = await registerPassword(username, password);

  // New keys, backed up on the server encrypted with the OPAQUE exportKey and the code.
  const keys = await generateUserKeys();
  const keyBackup = await wrapKeyBackup(exportKey, keys);
  const recoveryCode = generateRecoveryCode();

  const data = await post('/finaliseregister', {
    registrationRecord,
    userIdentifier: username,
    ...keys.public,
    keyBackup,
    ...(await recoveryFields(recoveryCode, keys)),
    acceptedTerms,
  });
  if (!data.token) return { user: null, recoveryCode };

  await storeUserKeys(data.id, keys);
  localStorage.setItem('token', data.token);
  return { user: { token: data.token, id: data.id, username: data.username, hasRecoveryCode: true, termsAccepted: true }, recoveryCode };
}

// Proves the logged-in user knows `password` (a fresh OPAQUE login) and opens their key
// backup with it. Resolves to { proof, keys }; `proof` goes along with the change.
async function unlockWithPassword(username, password) {
  if (!password) throw new Error(t('auth.errors.currentPasswordRequired'));
  const opaque = await loadOpaque();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const started = await post('/initiatelogin', { startLoginRequest, userIdentifier: username });
  const result = opaque.client.finishLogin({ clientLoginState, loginResponse: started.loginResponse, password });
  if (!result) throw new Error(t('auth.errors.currentPasswordIncorrect'));

  const { keyBackup } = await send('get', '/key-backup');
  let keys;
  try {
    keys = await unwrapKeyBackup(result.exportKey, keyBackup);
  } catch {
    throw new Error(t('auth.errors.keysLocked'));
  }
  return { proof: { finishLoginRequest: result.finishLoginRequest, clientSessionKey: result.sessionKey }, keys };
}

// Logged in: replaces the password. Other devices stay logged in.
export async function changePassword(username, currentPassword, newPassword) {
  checkNewPassword(newPassword);
  const { proof, keys } = await unlockWithPassword(username, currentPassword);
  const fields = await newPasswordFields(username, newPassword, keys);
  await post('/change-password', { ...proof, ...fields });
}

// Logged in: stores `code` as the account's recovery code (any old one stops working).
export async function saveRecoveryCode(username, password, code) {
  const { proof, keys } = await unlockWithPassword(username, password);
  await send('put', '/recovery-code', { ...proof, ...(await recoveryFields(code, keys)) });
}

// Logged in: makes and stores a new recovery code. Resolves to the code.
export async function createRecoveryCode(username, password) {
  const code = generateRecoveryCode();
  await saveRecoveryCode(username, password, code);
  return code;
}

// Your guilds that stop the account being deleted until they're handed over or deleted.
export async function fetchOwnedGuilds() {
  return send('get', '/account/owned-guilds');
}

// Logged in: deletes the account (see server/accounts.js). Signs a `leave` for each group DM
// here (only this device can), and with `deleteOwnedGuilds` deletes the guilds you own; without
// it, owning any is refused (the error has `guilds`). The caller logs out afterwards.
export async function deleteAccount(user, password, { deleteOwnedGuilds = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const { proof } = await unlockWithPassword(user.username, password);
    const groupLeaves = {};
    for (const group of await fetchGroups()) groupLeaves[group.id] = await leaveEntry(user, group.id);
    try {
      return (await api.delete('/account', { data: { ...proof, groupLeaves, deleteOwnedGuilds } })).data;
    } catch (err) {
      const data = err.response?.data;
      // A group changed meanwhile: sign again.
      if (data?.code === 'groups_changed' && attempt < 2) continue;
      throw Object.assign(new Error(data?.error || err.message), { code: data?.code, guilds: data?.guilds });
    }
  }
}

// A new code, not stored yet (see saveRecoveryCode): after logging in to an account that has
// none, it's shown first and only saved once the user says they've kept it.
export { generateRecoveryCode };

// Logged out, password forgotten: sets a new password with the recovery code and logs in.
// Resolves to the user, like logIn. The recovery code keeps working.
export async function recoverAccount(username, code, newPassword) {
  if (!username) throw new Error(t('auth.errors.usernameRequired'));
  if (!normalizeRecoveryCode(code)) throw new Error(t('auth.errors.notARecoveryCode'));
  checkNewPassword(newPassword);

  const auth = await recoveryAuth(code);
  const data = await post('/recover/start', { userIdentifier: username, recoveryAuth: auth });
  let keys;
  try {
    keys = await unwrapRecoveryBackup(code, data.recoveryBackup);
  } catch {
    throw new Error(t('auth.errors.keysLockedWithCode'));
  }
  if (PUBLIC_KEY_FIELDS.some((field) => keys.public[field] !== data[field])) {
    throw new Error(t('auth.errors.publicKeysMismatch'));
  }

  const fields = await newPasswordFields(username, newPassword, keys);
  const done = await post('/recover/finish', { userIdentifier: username, recoveryAuth: auth, ...fields });

  await storeUserKeys(done.id, keys);
  localStorage.setItem('token', done.token);
  return { token: done.token, id: done.id, username: done.username, hasRecoveryCode: true, termsAccepted: done.termsAccepted !== false };
}
