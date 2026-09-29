import * as opaque from '@serenity-kit/opaque';
import api from '../utils/api';
import { generateUserKeys, wrapKeyBackup, unwrapKeyBackup } from './encryptionService';
import { storeUserKeys } from './keyStore';

// Logging in and registering: OPAQUE (the password never leaves the device) plus the
// encryption keys, which the server keeps only as a backup encrypted with OPAQUE's
// exportKey. On success the keys go into this device's key store and the token into
// localStorage. (server/test/helpers/authFlow.js mirrors this protocol.)

// The password is what the encryption keys are protected with (and it can't be reset), so
// insist on a reasonable length. The server never sees it, so it can only be checked here.
export const MIN_PASSWORD_LENGTH = 10;

const PUBLIC_KEY_FIELDS = ['identityKey', 'encryptionKey', 'encryptionKeySignature'];

// Resolves to the user ({ token, id, username }); throws an Error with a message to show.
export async function logIn(username, password) {
  if (!username || !password) throw new Error('Username and password are required');

  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  // clientLoginState is this device's secret half of the OPAQUE exchange: never send it.
  const { data: started } = await api.post('/initiatelogin', { startLoginRequest, userIdentifier: username });
  const loginResult = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: started.loginResponse,
    password,
  });
  // Wrong password and unknown username look the same here (on purpose).
  if (!loginResult) throw new Error('Incorrect username or password');
  const { finishLoginRequest, sessionKey, exportKey } = loginResult;

  const { data } = await api.post('/finaliselogin', {
    finishLoginRequest,
    clientSessionKey: sessionKey,
    userIdentifier: username,
  });
  const { token, id, keyBackup } = data;
  if (!token || !keyBackup) throw new Error('Login failed');

  // The keys are encrypted with OPAQUE's exportKey, which only this password produces.
  let keys;
  try {
    keys = await unwrapKeyBackup(exportKey, keyBackup);
  } catch {
    throw new Error("Couldn't unlock your encryption keys.");
  }
  // The server must publish exactly the public keys in our own backup; otherwise other
  // people would be encrypting to keys that aren't ours.
  if (PUBLIC_KEY_FIELDS.some((field) => keys.public[field] !== data[field])) {
    throw new Error("The server's copy of your public keys doesn't match your account. Not logging in.");
  }

  await storeUserKeys(id, keys);
  localStorage.setItem('token', token);
  return { token, id, username: data.username };
}

// Creates the account with new keys. Resolves to the logged-in user ({ token, id,
// username }), or null if the server registered it without logging in.
export async function register(username, password) {
  if (!username || !password) throw new Error('Username and password are required');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const { data: started } = await api.post('/initiateregister', { userIdentifier: username, registrationRequest });
  if (started.error) throw new Error(started.error);
  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.registrationResponse,
    password,
  });

  // New keys, backed up on the server encrypted with the OPAQUE exportKey.
  const keys = await generateUserKeys();
  const keyBackup = await wrapKeyBackup(exportKey, keys);

  const { data } = await api.post('/finaliseregister', {
    registrationRecord,
    userIdentifier: username,
    ...keys.public,
    keyBackup,
  });
  if (!data.token) return null;

  await storeUserKeys(data.id, keys);
  localStorage.setItem('token', data.token);
  return data;
}
