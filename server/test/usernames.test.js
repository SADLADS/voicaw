import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import opaque from '@serenity-kit/opaque';
import { generateUserKeys, wrapKeyBackup, generateRecoveryCode, recoveryAuth, unwrapRecoveryBackup } from '../../client/src/services/encryptionService.js';
import { registerUser, loginUser, passwordProof, newPasswordFields, recoveryFields } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const userRow = (id) => db.get('SELECT username, display_name, opaque_id FROM users WHERE id = ?', [id]);

// An account made before usernames were lower-cased: its OPAQUE record is bound to the name
// exactly as typed, capitals and all.
async function legacyAccount(username, password, { displayName = null, recoveryCode } = {}) {
  await opaque.ready;
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup: process.env.OPAQUE_SERVER_SETUP, userIdentifier: username, registrationRequest,
  });
  const { registrationRecord, exportKey } = opaque.client.finishRegistration({ clientRegistrationState, registrationResponse, password });
  const keys = await generateUserKeys();
  const recovery = recoveryCode ? await recoveryFields(recoveryCode, keys) : {};
  const { lastID } = await db.run(
    `INSERT INTO users (username, display_name, password, identity_key, encryption_key, encryption_key_signature,
       key_backup, recovery_verifier, recovery_backup)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, displayName, registrationRecord, keys.public.identityKey, keys.public.encryptionKey,
      keys.public.encryptionKeySignature, await wrapKeyBackup(exportKey, keys), recovery.recoveryVerifier, recovery.recoveryBackup]
  );
  return { id: lastID, keys };
}

describe('usernames ignore capitals', () => {
  it('signs up in lower case, with the capitals as the display name', async () => {
    const { response } = await registerUser(app, request, 'CapsUser', 'password1234');
    expect(response.status).toBe(201);
    expect(response.body.username).toBe('capsuser');
    expect(response.body.display_name).toBe('CapsUser');
    expect(await userRow(response.body.id)).toEqual({ username: 'capsuser', display_name: 'CapsUser', opaque_id: null });

    for (const typed of ['capsuser', 'CAPSUSER', 'CapsUser']) {
      const login = await loginUser(app, request, typed, 'password1234');
      expect(login.response.status).toBe(200);
      expect(login.response.body.username).toBe('capsuser');
    }
    expect((await registerUser(app, request, 'CAPSuser', 'password1234')).response.status).toBe(409);
    expect((await registerUser(app, request, 'capsuser', 'password1234')).response.status).toBe(409);
  });

  it('leaves the display name empty for a lower-case sign-up', async () => {
    const { response } = await registerUser(app, request, 'plainuser', 'password1234');
    expect(response.body.display_name).toBeNull();
  });

  it('makes admins by name in any capitals', async () => {
    const { response } = await registerUser(app, request, 'admin-caps', 'password1234');
    await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [response.body.id]);
    await registerUser(app, request, 'Promoted', 'password1234');
    const res = await request(app).post('/api/admin/admins').set(auth(response.body.token)).send({ username: 'PROMOTED' });
    expect(res.status).toBe(200);
    expect(res.body.admins.map((a) => a.username)).toContain('promoted');
  });
});

describe('migrating existing accounts', () => {
  it('lower-cases them and they keep logging in, changing password and recovering', async () => {
    const code = generateRecoveryCode();
    const legacy = await legacyAccount('OldTimer', 'password1234', { recoveryCode: code });
    const named = await legacyAccount('Named', 'password1234', { displayName: 'Chosen name' });
    // Lower-casing this one would clash with an account that's already lower case.
    const taken = await legacyAccount('taken', 'password1234');
    const clash = await legacyAccount('TAKEN', 'other password');

    db.lowercaseUsernames();
    expect(await userRow(legacy.id)).toEqual({ username: 'oldtimer', display_name: 'OldTimer', opaque_id: 'OldTimer' });
    expect(await userRow(named.id)).toEqual({ username: 'named', display_name: 'Chosen name', opaque_id: 'Named' });
    expect((await userRow(taken.id)).username).toBe('taken');
    expect(await userRow(clash.id)).toEqual({ username: 'TAKEN', display_name: null, opaque_id: null });

    // Same password, any capitals, same keys.
    for (const typed of ['oldtimer', 'OldTimer', 'OLDTIMER']) {
      const login = await loginUser(app, request, typed, 'password1234');
      expect(login.response.status).toBe(200);
      expect(login.response.body.username).toBe('oldtimer');
      expect(login.keys.private).toEqual(legacy.keys.private);
    }
    expect((await loginUser(app, request, 'taken', 'password1234')).response.status).toBe(200);
    const clashLogin = await loginUser(app, request, 'TAKEN', 'other password');
    expect(clashLogin.response.body.id).toBe(clash.id);

    // A new password is registered under the lower-case name.
    const token = (await loginUser(app, request, 'oldtimer', 'password1234')).response.body.token;
    const proof = await passwordProof(app, request, 'oldtimer', 'password1234');
    const fields = await newPasswordFields(app, request, 'OldTimer', 'new password 1', legacy.keys);
    const changed = await request(app).post('/api/change-password').set(auth(token))
      .send({ finishLoginRequest: proof.finishLoginRequest, clientSessionKey: proof.clientSessionKey, ...fields });
    expect(changed.status).toBe(200);
    expect((await userRow(legacy.id)).opaque_id).toBeNull();
    expect((await loginUser(app, request, 'OLDTIMER', 'new password 1')).keys.private).toEqual(legacy.keys.private);

    // Recovery with the capitals typed works too.
    const auth1 = await recoveryAuth(code);
    const start = await request(app).post('/api/recover/start').send({ userIdentifier: 'OldTimer', recoveryAuth: auth1 });
    expect(start.status).toBe(200);
    const keys = await unwrapRecoveryBackup(code, start.body.recoveryBackup);
    const newFields = { ...(await newPasswordFields(app, request, 'OldTimer', 'newer password', keys)), ...(await recoveryFields(generateRecoveryCode(), keys)) };
    const finish = await request(app).post('/api/recover/finish').send({ userIdentifier: 'OldTimer', recoveryAuth: auth1, ...newFields });
    expect(finish.status).toBe(200);
    expect(finish.body.username).toBe('oldtimer');
    expect((await loginUser(app, request, 'oldtimer', 'newer password')).response.status).toBe(200);

    // A token from before the rename still gets the new username.
    const { generateToken } = require('../auth');
    const oldToken = generateToken({ id: named.id, username: 'Named' });
    expect((await request(app).get('/api/profile').set(auth(oldToken))).body.username).toBe('named');
  });
});
