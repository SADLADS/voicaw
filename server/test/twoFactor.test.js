import './helpers/mockS3.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser, passwordProof, newPasswordFields, recoveryFields } from './helpers/authFlow.js';
import { generateRecoveryCode, recoveryAuth, unwrapKeyBackup } from '../../client/src/services/encryptionService.js';

const app = require('../index.js');
const twoFactor = require('../twoFactor.js');
const auth = (token) => ({ Authorization: `Bearer ${token}` });

// Codes work once each, so tests move the clock on a step (30 s) before using another.
let clock = Date.now();
const nextStep = () => {
  clock += twoFactor.STEP_SECONDS * 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
};
afterEach(() => vi.useRealTimers());
const codeNow = (secret) => twoFactor.totp(secret, twoFactor.currentStep());

// Registers `username` and turns two-factor on: { token, keys, secret, backupCodes }.
async function userWithTwoFactor(username, password = 'password1234', options) {
  const { response, keys } = await registerUser(app, request, username, password, options);
  const token = response.body.token;
  const secret = twoFactor.newSecret();
  const { exportKey, ...proof } = await passwordProof(app, request, username, password);
  const res = await request(app).post('/api/two-factor/enable').set(auth(token)).send({ ...proof, secret, code: codeNow(secret) });
  expect(res.status).toBe(200);
  return { token, keys, secret, backupCodes: res.body.backupCodes };
}

describe('TOTP', () => {
  it('matches RFC 6238 (SHA-1 test vector, last six digits)', () => {
    const secret = twoFactor.base32Encode(Buffer.from('12345678901234567890'));
    expect(twoFactor.totp(secret, 1)).toBe('287082'); // T = 59 s
    expect(twoFactor.totp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(twoFactor.totp(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts the next and previous steps, but never one already used', () => {
    const secret = twoFactor.newSecret();
    const now = twoFactor.currentStep();
    expect(twoFactor.matchTotp(secret, twoFactor.totp(secret, now - 1))).toBe(now - 1);
    expect(twoFactor.matchTotp(secret, twoFactor.totp(secret, now + 1))).toBe(now + 1);
    expect(twoFactor.matchTotp(secret, twoFactor.totp(secret, now - 3))).toBeNull();
    expect(twoFactor.matchTotp(secret, twoFactor.totp(secret, now), now)).toBeNull();
  });

  it('takes only 20-byte base32 secrets from the client', () => {
    expect(twoFactor.secretFromClient(twoFactor.newSecret().toLowerCase())).toMatch(/^[A-Z2-7]{32}$/);
    expect(twoFactor.secretFromClient('AAAA')).toBeNull();
    expect(twoFactor.secretFromClient('not base32!')).toBeNull();
  });
});

describe('two-factor', () => {
  it('is off by default, and logging in works as before', async () => {
    const { response } = await registerUser(app, request, 'tf-off', 'password1234');
    const status = await request(app).get('/api/two-factor').set(auth(response.body.token));
    expect(status.body).toEqual({ enabled: false, backupCodesLeft: 0 });
    const login = await loginUser(app, request, 'tf-off', 'password1234');
    expect(login.response.body.token).toBeTruthy();
    expect(login.response.body.twoFactor).toBeUndefined();
  });

  it('needs the password and a right code to turn on', async () => {
    const { response } = await registerUser(app, request, 'tf-on', 'password1234');
    const token = response.body.token;
    const secret = twoFactor.newSecret();
    const wrongCode = String((Number(codeNow(secret)) + 1) % 1e6).padStart(6, '0');
    let { exportKey, ...proof } = await passwordProof(app, request, 'tf-on', 'password1234');
    const wrong = await request(app).post('/api/two-factor/enable').set(auth(token)).send({ ...proof, secret, code: wrongCode });
    expect(wrong.status).toBe(400);
    ({ exportKey, ...proof } = await passwordProof(app, request, 'tf-on', 'password1234'));
    const noProof = await request(app).post('/api/two-factor/enable').set(auth(token)).send({ secret, code: codeNow(secret) });
    expect(noProof.status).toBe(400);
    const ok = await request(app).post('/api/two-factor/enable').set(auth(token)).send({ ...proof, secret, code: codeNow(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.backupCodes).toHaveLength(10);
    expect(ok.body.backupCodes[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect((await request(app).get('/api/two-factor').set(auth(token))).body).toEqual({ enabled: true, backupCodesLeft: 10 });
  });

  it('holds back the session and the key backup until a code is given', async () => {
    const { secret, keys } = await userWithTwoFactor('tf-login');
    const login = await loginUser(app, request, 'tf-login', 'password1234');
    expect(login.response.status).toBe(200);
    expect(login.response.body).toEqual({ twoFactor: true, ticket: expect.any(String) });
    const { ticket } = login.response.body;

    // The code used to turn it on doesn't work again.
    const reused = await request(app).post('/api/login/two-factor').send({ ticket, code: codeNow(secret) });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('two_factor_invalid');

    nextStep();
    const ok = await request(app).post('/api/login/two-factor').send({ ticket, code: codeNow(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(await unwrapKeyBackup(login.exportKey, ok.body.keyBackup)).toEqual(keys);
    expect((await request(app).get('/api/profile').set(auth(ok.body.token))).status).toBe(200);

    // The ticket is used up.
    const again = await request(app).post('/api/login/two-factor').send({ ticket, code: codeNow(secret) });
    expect(again.body.code).toBe('two_factor_expired');
  });

  it('takes each backup code once', async () => {
    const { backupCodes } = await userWithTwoFactor('tf-backup');
    const first = await loginUser(app, request, 'tf-backup', 'password1234');
    const ok = await request(app).post('/api/login/two-factor')
      .send({ ticket: first.response.body.ticket, code: backupCodes[3].toUpperCase().replace('-', ' ') });
    expect(ok.status).toBe(200);
    const second = await loginUser(app, request, 'tf-backup', 'password1234');
    const reused = await request(app).post('/api/login/two-factor').send({ ticket: second.response.body.ticket, code: backupCodes[3] });
    expect(reused.status).toBe(401);
    expect((await request(app).get('/api/two-factor').set(auth(ok.body.token))).body.backupCodesLeft).toBe(9);
  });

  it('drops a ticket after a few wrong codes', async () => {
    await userWithTwoFactor('tf-guess');
    const { ticket } = (await loginUser(app, request, 'tf-guess', 'password1234')).response.body;
    const codes = [];
    for (let i = 0; i < twoFactor.TICKET_ATTEMPTS; i++) {
      codes.push((await request(app).post('/api/login/two-factor').send({ ticket, code: 'aaaa-aaaa' })).body.code);
    }
    expect(codes.at(-1)).toBe('two_factor_invalid');
    const after = await request(app).post('/api/login/two-factor').send({ ticket, code: 'aaaa-aaaa' });
    expect(after.body.code).toBe('two_factor_expired');
  });

  it('needs a code to reset the password with the recovery code', async () => {
    const recoveryCode = generateRecoveryCode();
    const { secret, keys } = await userWithTwoFactor('tf-recover', 'password1234', { recoveryCode });
    const recoveryAuthValue = await recoveryAuth(recoveryCode);
    const start = await request(app).post('/api/recover/start').send({ userIdentifier: 'tf-recover', recoveryAuth: recoveryAuthValue });
    expect(start.body.twoFactor).toBe(true);

    const newCode = generateRecoveryCode();
    const fields = { ...(await newPasswordFields(app, request, 'tf-recover', 'new password 1', keys)), ...(await recoveryFields(newCode, keys)) };
    const send = (extra) => request(app).post('/api/recover/finish').send({ userIdentifier: 'tf-recover', recoveryAuth: recoveryAuthValue, ...fields, ...extra });
    expect((await send({})).body.code).toBe('two_factor_required');
    expect((await send({ twoFactorCode: '000000' })).body.code).toBe('two_factor_invalid');
    // The old password and recovery code still work: nothing was changed.
    expect((await loginUser(app, request, 'tf-recover', 'password1234')).response.body.twoFactor).toBe(true);
    expect((await request(app).post('/api/recover/start').send({ userIdentifier: 'tf-recover', recoveryAuth: recoveryAuthValue })).status).toBe(200);

    nextStep();
    const ok = await send({ twoFactorCode: codeNow(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
  });

  it('turns off with the password and a code, and makes new backup codes the same way', async () => {
    const { token, secret, backupCodes } = await userWithTwoFactor('tf-disable');
    const proof = async () => {
      const { exportKey, ...p } = await passwordProof(app, request, 'tf-disable', 'password1234');
      return p;
    };

    const noCode = await request(app).post('/api/two-factor/disable').set(auth(token)).send({ ...(await proof()) });
    expect(noCode.status).toBe(401);

    const fresh = await request(app).post('/api/two-factor/backup-codes').set(auth(token)).send({ ...(await proof()), code: backupCodes[0] });
    expect(fresh.status).toBe(200);
    expect(fresh.body.backupCodes).toHaveLength(10);
    // The old set stopped working.
    const old = await request(app).post('/api/two-factor/disable').set(auth(token)).send({ ...(await proof()), code: backupCodes[1] });
    expect(old.status).toBe(401);

    nextStep();
    const off = await request(app).post('/api/two-factor/disable').set(auth(token)).send({ ...(await proof()), code: codeNow(secret) });
    expect(off.status).toBe(200);
    expect((await request(app).get('/api/two-factor').set(auth(token))).body.enabled).toBe(false);
    expect((await loginUser(app, request, 'tf-disable', 'password1234')).response.body.token).toBeTruthy();
  });

  it('is forgotten with a deleted account', async () => {
    const { token } = await userWithTwoFactor('tf-delete');
    const { exportKey, ...proof } = await passwordProof(app, request, 'tf-delete', 'password1234');
    const res = await request(app).delete('/api/account').set(auth(token)).send({ ...proof, groupLeaves: {} });
    expect(res.status).toBe(200);
    const db = require('../db.js');
    const row = await db.get("SELECT two_factor_secret, two_factor_backup_codes FROM users WHERE username LIKE 'Deleted-User-%' ORDER BY id DESC LIMIT 1");
    expect(row).toEqual({ two_factor_secret: null, two_factor_backup_codes: null });
  });
});
