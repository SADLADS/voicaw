import opaque from '@serenity-kit/opaque';
import { generateUserKeys, wrapKeyBackup, unwrapKeyBackup } from '../../../client/src/services/encryptionService.js';

// Mirrors what client/src/services/authService.js does (OPAQUE, then keys wrapped with the
// OPAQUE exportKey), so integration tests exercise the real client/server protocol.

export async function registerUser(app, request, username, password) {
  await opaque.ready;

  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });

  const initiateRes = await request(app)
    .post('/api/initiateregister')
    .send({ userIdentifier: username, registrationRequest });
  if (initiateRes.body.error) {
    throw new Error(`initiateregister failed: ${initiateRes.body.error}`);
  }

  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: initiateRes.body.registrationResponse,
    password,
  });

  const keys = await generateUserKeys();
  const keyBackup = await wrapKeyBackup(exportKey, keys);

  const finaliseRes = await request(app)
    .post('/api/finaliseregister')
    .send({ registrationRecord, userIdentifier: username, ...keys.public, keyBackup });

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
