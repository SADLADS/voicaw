#!/usr/bin/env node
// Uploads an App Bundle to Google Play and releases it on a track (README "Android app"), with
// the Google Play Developer API: a new edit, the bundle, the track's release, then commit.
//
//   node updates/publish-play.mjs <signed-play.aab> <version>
//   node updates/publish-play.mjs check
//       logs in and opens an edit, lists the app's tracks, then deletes the edit: checks the key
//       and its access without changing anything on Play
//
// Needs a Google Cloud service account's JSON key with access to the app in the Play Console
// (README "Android app": set up once), at VOICAW_PLAY_KEY, default
// ~/.voicaw-android-keys/play-service-account.json. VOICAW_PLAY_TRACK picks the track: alpha
// (Play's closed testing, the default while the app is in its closed test), beta, internal or
// production. The bundle must be signed with the upload key (ours: mobile/sign-android.sh), and
// its version higher than every one Play has seen.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = 'com.voicaw.app';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
// VOICAW_PLAY_API is for tests (a stand-in server).
const API = process.env.VOICAW_PLAY_API || 'https://androidpublisher.googleapis.com';

export const keyPath = () => process.env.VOICAW_PLAY_KEY
  || path.join(process.env.VOICAW_ANDROID_KEYS || path.join(os.homedir(), '.voicaw-android-keys'), 'play-service-account.json');

const base64url = (data) => Buffer.from(data).toString('base64url');

// An OAuth access token for the service account (a signed JWT exchanged at its token_uri).
async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 3600 }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.private_key).toString('base64url');
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Google refused the service account (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

const readKey = () => JSON.parse(fs.readFileSync(keyPath(), 'utf8'));
const app = `applications/${PACKAGE}`;

// call(method, url, body, type): the API with the service account's token.
async function api(key) {
  const token = await accessToken(key);
  return async (method, url, body, type = 'application/json') => {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': type }) },
      body: body && (type === 'application/json' ? JSON.stringify(body) : body),
    });
    if (!res.ok) throw new Error(`Google Play: ${method} ${new URL(url).pathname} failed (${res.status}): ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };
}

// Checks the key and its access to the app, changing nothing: the edit is deleted, not committed.
export async function checkPlay({ key = readKey() } = {}) {
  const call = await api(key);
  console.log(`Google Play: logged in as ${key.client_email}.`);
  const edit = await call('POST', `${API}/androidpublisher/v3/${app}/edits`, {});
  const editUrl = `${API}/androidpublisher/v3/${app}/edits/${edit.id}`;
  try {
    const { tracks = [] } = await call('GET', `${editUrl}/tracks`);
    for (const t of tracks) {
      const latest = (t.releases || []).map((r) => `${r.name ?? '?'} (${r.status})`).join(', ') || 'no releases';
      console.log(`  ${t.track}: ${latest}`);
    }
  } finally {
    await call('DELETE', editUrl);
  }
  console.log(`Google Play: ${PACKAGE} can be reached; nothing was changed.`);
}

export async function publishPlay(aab, version, { track = process.env.VOICAW_PLAY_TRACK || 'alpha', key = readKey() } = {}) {
  const call = await api(key);
  const edit = await call('POST', `${API}/androidpublisher/v3/${app}/edits`, {});
  const editUrl = `${API}/androidpublisher/v3/${app}/edits/${edit.id}`;
  const bundle = await call('POST', `${API}/upload/androidpublisher/v3/${app}/edits/${edit.id}/bundles?uploadType=media`,
    fs.readFileSync(aab), 'application/octet-stream');
  await call('PUT', `${editUrl}/tracks/${track}`, {
    track,
    // Named as the Play Console names releases: "10203 (1.2.3)".
    releases: [{ name: `${bundle.versionCode} (${version})`, versionCodes: [String(bundle.versionCode)], status: 'completed' }],
  });
  await call('POST', `${editUrl}:commit`);
  console.log(`Google Play: ${version} (versionCode ${bundle.versionCode}) released on ${track}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [aab, version] = process.argv.slice(2);
  if (aab !== 'check' && (!aab || !version)) {
    console.error('usage: publish-play.mjs <signed-play.aab> <version> | check');
    process.exit(1);
  }
  (aab === 'check' ? checkPlay() : publishPlay(path.resolve(aab), version)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
