import opaque from '@serenity-kit/opaque';
import { generateECDH_P256_PEM, encryptPrivateKey } from '../../../client/src/services/encryptionService.js';

// Mirrors the OPAQUE + key-wrapping dance client/src/components/Login.jsx performs,
// so integration tests exercise the real client/server protocol instead of a stub.

export async function registerUser(app, request, username, password) {
  await opaque.ready;

  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const { publicPEM, privatePEM } = await generateECDH_P256_PEM();
  const encryptedPrivateKey = await encryptPrivateKey(privatePEM, password);

  const initiateRes = await request(app)
    .post('/api/initiateregister')
    .send({ userIdentifier: username, registrationRequest });
  if (initiateRes.body.error) {
    throw new Error(`initiateregister failed: ${initiateRes.body.error}`);
  }

  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: initiateRes.body.registrationResponse,
    password,
  });

  const finaliseRes = await request(app)
    .post('/api/finaliseregister')
    .send({
      registrationRecord,
      userIdentifier: username,
      publicKey: publicPEM,
      encryptedPrivateKey,
    });

  return { response: finaliseRes, publicPEM, privatePEM };
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

  const { finishLoginRequest, sessionKey } = loginResult;

  const finaliseRes = await request(app)
    .post('/api/finaliselogin')
    .send({ finishLoginRequest, clientSessionKey: sessionKey, userIdentifier: username });

  return { response: finaliseRes };
}
