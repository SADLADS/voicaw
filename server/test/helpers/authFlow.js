import opaque from '@serenity-kit/opaque';
import { createRequire } from 'node:module';
import {
  generateUserKeys, wrapKeyBackup, unwrapKeyBackup, recoveryAuth, recoveryVerifier, wrapRecoveryBackup,
} from '../../../client/src/services/encryptionService.js';

// Mirrors what client/src/services/authService.js does (OPAQUE, then keys wrapped with the
// OPAQUE exportKey), so integration tests exercise the real client/server protocol.

// The terms of use the app's tick accepts (server/terms.js). Loaded when first needed, not on
// import: that would load the server's config before a test file has set its environment.
const require = createRequire(import.meta.url);
const currentTerms = () => require('../../terms.js').TERMS_VERSION;

// With `recoveryCode`, the account is registered with that recovery code; with `invite`, with
// that app invite (server/signups.js). `acceptedTerms`: what the sign-up's terms tick sends (the
// current terms by default; null for none).
export async function registerUser(app, request, username, password, { recoveryCode, invite, acceptedTerms = currentTerms() } = {}) {
  await opaque.ready;

  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });

  const initiateRes = await request(app)
    .post('/api/initiateregister')
    .send({ userIdentifier: username, registrationRequest, signup: true, invite });
  if (initiateRes.body.error) {
    return { response: initiateRes, failedAt: 'initiate' };
  }

  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: initiateRes.body.registrationResponse,
    password,
  });

  const keys = await generateUserKeys();
  const keyBackup = await wrapKeyBackup(exportKey, keys);

  const recovery = recoveryCode ? await recoveryFields(recoveryCode, keys) : {};

  const finaliseRes = await request(app)
    .post('/api/finaliseregister')
    .send({ registrationRecord, userIdentifier: username, ...keys.public, keyBackup, ...recovery, invite, ...(acceptedTerms ? { acceptedTerms } : {}) });

  return { response: finaliseRes, keys, exportKey };
}

export async function loginUser(app, request, username, password) {
  await opaque.ready;

  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });

  const initiateRes = await request(app)
    .post('/api/initiatelogin')
    .send({ userIdentifier: username, startLoginRequest });
  if (initiateRes.body.error) {
    return { response: initiateRes, failedAt: 'initiate' };
  }

  const loginResult = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: initiateRes.body.loginResponse,
    password,
  });

  if (!loginResult) {
    return { response: initiateRes, failedAt: 'finishLogin-client' };
  }

  const { finishLoginRequest, sessionKey, exportKey } = loginResult;

  const finaliseRes = await request(app)
    .post('/api/finaliselogin')
    .send({ finishLoginRequest, clientSessionKey: sessionKey, userIdentifier: username });

  // As the client does: open the key backup with this login's exportKey.
  const keys = finaliseRes.body.keyBackup ? await unwrapKeyBackup(exportKey, finaliseRes.body.keyBackup) : null;
  return { response: finaliseRes, exportKey, keys };
}

// { recoveryVerifier, recoveryBackup } for a recovery code, as the client sends them.
export async function recoveryFields(code, keys) {
  return {
    recoveryVerifier: await recoveryVerifier(await recoveryAuth(code)),
    recoveryBackup: await wrapRecoveryBackup(code, keys),
  };
}

// A fresh OPAQUE login proof ({ finishLoginRequest, clientSessionKey }, plus the exportKey),
// as sent with changes that need the current password. null if the client rejects it.
export async function passwordProof(app, request, username, password) {
  await opaque.ready;
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const started = await request(app).post('/api/initiatelogin').send({ userIdentifier: username, startLoginRequest });
  const result = opaque.client.finishLogin({ clientLoginState, loginResponse: started.body.loginResponse, password });
  if (!result) return null;
  return { finishLoginRequest: result.finishLoginRequest, clientSessionKey: result.sessionKey, exportKey: result.exportKey };
}

// A new password's { registrationRecord, keyBackup } (the keys encrypted with its exportKey).
export async function newPasswordFields(app, request, username, password, keys) {
  await opaque.ready;
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const started = await request(app).post('/api/initiateregister').send({ userIdentifier: username, registrationRequest });
  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.body.registrationResponse,
    password,
  });
  return { registrationRecord, keyBackup: await wrapKeyBackup(exportKey, keys) };
}
