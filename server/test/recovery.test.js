import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser, recoveryFields, passwordProof, newPasswordFields } from './helpers/authFlow.js';
import {
  generateRecoveryCode, normalizeRecoveryCode, recoveryAuth, unwrapRecoveryBackup, unwrapKeyBackup,
} from '../../client/src/services/encryptionService.js';

const app = require('../index.js');
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('recovery codes (crypto)', () => {
  it('generates 25-character codes in groups of five that normalise back', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('reads O as 0 and I/L as 1, and rejects anything else', () => {
    expect(normalizeRecoveryCode('OOOOO-IIIII-LLLLL-00000-11111')).toBe('0000011111111110000011111');
    expect(normalizeRecoveryCode('ABCDE')).toBeNull();
    expect(normalizeRecoveryCode('UUUUU-UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull();
  });
});

describe('recovery code at registration', () => {
  it('stores it and reports hasRecoveryCode on register, login and profile', async () => {
    const code = generateRecoveryCode();
    const { response } = await registerUser(app, request, 'rec-reg', 'password1234', { recoveryCode: code });
    expect(response.status).toBe(201);
    expect(response.body.hasRecoveryCode).toBe(true);

    const login = await loginUser(app, request, 'rec-reg', 'password1234');
    expect(login.response.body.hasRecoveryCode).toBe(true);
    const profile = await request(app).get('/api/profile').set(auth(login.response.body.token));
    expect(profile.body.hasRecoveryCode).toBe(true);
  });

  it('is optional', async () => {
    const { response } = await registerUser(app, request, 'rec-none', 'password1234');
    expect(response.body.hasRecoveryCode).toBe(false);
  });

  it('rejects a malformed verifier', async () => {
    const res = await request(app).post('/api/finaliseregister').send({ recoveryVerifier: 'x', recoveryBackup: '{}' });
    expect(res.status).toBe(400);
  });
});

describe('recovering an account', () => {
  // `newCode`: the code replacing it (a fresh one by default; null sends none).
  async function recover(username, code, newPassword, { newCode = generateRecoveryCode() } = {}) {
    const recoveryAuthValue = await recoveryAuth(code);
    const start = await request(app).post('/api/recover/start').send({ userIdentifier: username, recoveryAuth: recoveryAuthValue });
    if (start.status !== 200) return { start };
    const keys = await unwrapRecoveryBackup(code, start.body.recoveryBackup);
    const fields = await newPasswordFields(app, request, username, newPassword, keys);
    const finish = await request(app).post('/api/recover/finish').send({
      userIdentifier: username, recoveryAuth: recoveryAuthValue, ...fields, ...(newCode && (await recoveryFields(newCode, keys))),
    });
    return { start, keys, finish, newCode };
  }

  it('sets a new password with the code, keeping the keys, and replaces the code', async () => {
    const code = generateRecoveryCode();
    const { keys } = await registerUser(app, request, 'rec-user', 'old password 1', { recoveryCode: code });

    const { start, keys: recovered, finish, newCode } = await recover('rec-user', code, 'new password 1');
    expect(start.status).toBe(200);
    expect(start.body.identityKey).toBe(keys.public.identityKey);
    expect(recovered).toEqual({ public: keys.public, private: keys.private });
    expect(finish.status).toBe(200);
    expect(finish.body.token).toBeTruthy();

    expect((await loginUser(app, request, 'rec-user', 'old password 1')).failedAt).toBe('finishLogin-client');
    const login = await loginUser(app, request, 'rec-user', 'new password 1');
    expect(login.response.status).toBe(200);
    expect(login.keys.private).toEqual(keys.private);

    expect(finish.body.hasRecoveryCode).toBe(true);

    // The used code stops working; the new one opens the same keys.
    expect((await recover('rec-user', code, 'newer password')).start.status).toBe(401);
    const again = await recover('rec-user', newCode, 'newer password');
    expect(again.keys).toEqual({ public: keys.public, private: keys.private });
    expect(again.finish.status).toBe(200);
  });

  it('refuses to finish without a new code, or with the same one, changing nothing', async () => {
    const code = generateRecoveryCode();
    await registerUser(app, request, 'rec-same', 'password1234', { recoveryCode: code });

    const none = await recover('rec-same', code, 'new password 1', { newCode: null });
    expect(none.finish.status).toBe(400);
    expect(none.finish.body.code).toBe('new_recovery_code_required');
    const same = await recover('rec-same', code, 'new password 1', { newCode: code });
    expect(same.finish.status).toBe(400);

    expect((await loginUser(app, request, 'rec-same', 'password1234')).response.status).toBe(200);
    expect((await recover('rec-same', code, 'new password 1')).finish.status).toBe(200);
  });

  it('refuses a wrong code, an unknown user and a user without a code alike', async () => {
    const code = generateRecoveryCode();
    await registerUser(app, request, 'rec-wrong', 'password1234', { recoveryCode: code });
    await registerUser(app, request, 'rec-nocode', 'password1234');

    for (const [user, tryCode] of [['rec-wrong', generateRecoveryCode()], ['rec-unknown', code], ['rec-nocode', code]]) {
      const { start } = await recover(user, tryCode, 'whatever12');
      expect(start.status).toBe(401);
      expect(start.body.error).toBe('Wrong username or recovery code');
    }
  });

  it('needs the code again to finish', async () => {
    const code = generateRecoveryCode();
    const { keys } = await registerUser(app, request, 'rec-finish', 'password1234', { recoveryCode: code });
    const fields = await newPasswordFields(app, request, 'rec-finish', 'hijacked123', keys);
    const res = await request(app).post('/api/recover/finish')
      .send({ userIdentifier: 'rec-finish', recoveryAuth: await recoveryAuth(generateRecoveryCode()), ...fields });
    expect(res.status).toBe(401);
    expect((await loginUser(app, request, 'rec-finish', 'password1234')).response.status).toBe(200);
  });
});

describe('while logged in', () => {
  it('changes the password with the current one', async () => {
    const { response, keys } = await registerUser(app, request, 'chg-user', 'old password 1');
    const token = response.body.token;

    const backup = await request(app).get('/api/key-backup').set(auth(token));
    const proof = await passwordProof(app, request, 'chg-user', 'old password 1');
    expect(await unwrapKeyBackup(proof.exportKey, backup.body.keyBackup)).toEqual({ public: keys.public, private: keys.private });

    const fields = await newPasswordFields(app, request, 'chg-user', 'new password 1', keys);
    const res = await request(app).post('/api/change-password').set(auth(token))
      .send({ finishLoginRequest: proof.finishLoginRequest, clientSessionKey: proof.clientSessionKey, ...fields });
    expect(res.status).toBe(200);

    expect((await loginUser(app, request, 'chg-user', 'old password 1')).failedAt).toBe('finishLogin-client');
    const login = await loginUser(app, request, 'chg-user', 'new password 1');
    expect(login.keys.private).toEqual(keys.private);
  });

  it("refuses without a valid proof of the current password", async () => {
    const { response, keys } = await registerUser(app, request, 'chg-noproof', 'password1234');
    const token = response.body.token;
    const fields = await newPasswordFields(app, request, 'chg-noproof', 'new password 1', keys);

    const none = await request(app).post('/api/change-password').set(auth(token)).send(fields);
    expect(none.status).toBe(400);

    // A proof for someone else's account doesn't count.
    await registerUser(app, request, 'chg-other', 'password1234');
    const other = await passwordProof(app, request, 'chg-other', 'password1234');
    const wrong = await request(app).post('/api/change-password').set(auth(token))
      .send({ finishLoginRequest: other.finishLoginRequest, clientSessionKey: other.clientSessionKey, ...fields });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('Current password is incorrect');

    expect((await loginUser(app, request, 'chg-noproof', 'password1234')).response.status).toBe(200);
  });

  it('sets up and replaces the recovery code', async () => {
    const { response, keys } = await registerUser(app, request, 'rc-setup', 'password1234');
    const token = response.body.token;
    const first = generateRecoveryCode();
    const second = generateRecoveryCode();

    for (const code of [first, second]) {
      const proof = await passwordProof(app, request, 'rc-setup', 'password1234');
      const res = await request(app).put('/api/recovery-code').set(auth(token))
        .send({ finishLoginRequest: proof.finishLoginRequest, clientSessionKey: proof.clientSessionKey, ...(await recoveryFields(code, keys)) });
      expect(res.status).toBe(200);
    }

    const tryCode = async (code) => request(app).post('/api/recover/start')
      .send({ userIdentifier: 'rc-setup', recoveryAuth: await recoveryAuth(code) });
    expect((await tryCode(first)).status).toBe(401);
    const ok = await tryCode(second);
    expect(ok.status).toBe(200);
    expect(await unwrapRecoveryBackup(second, ok.body.recoveryBackup)).toEqual({ public: keys.public, private: keys.private });
  });

  it('needs the password to set a recovery code', async () => {
    const { response, keys } = await registerUser(app, request, 'rc-noproof', 'password1234');
    const res = await request(app).put('/api/recovery-code').set(auth(response.body.token))
      .send(await recoveryFields(generateRecoveryCode(), keys));
    expect(res.status).toBe(400);
  });
});
