#!/usr/bin/env node
// Uploads an App Bundle to Google Play and releases it on a track (release_all.sh runs it), with
// the Google Play Developer API: a new edit, the bundle, the track's release, then commit.
//
//   node updates/publish-play.mjs <signed-play.aab> <version>
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

export async function publishPlay(aab, version, { track = process.env.VOICAW_PLAY_TRACK || 'alpha', key = JSON.parse(fs.readFileSync(keyPath(), 'utf8')) } = {}) {
  const token = await accessToken(key);
  const call = async (method, url, body, type = 'application/json') => {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': type }) },
      body: body && (type === 'application/json' ? JSON.stringify(body) : body),
    });
    if (!res.ok) throw new Error(`Google Play: ${method} ${new URL(url).pathname} failed (${res.status}): ${await res.text()}`);
    return res.json();
  };
  const app = `applications/${PACKAGE}`;
  const edit = await call('POST', `${API}/androidpublisher/v3/${app}/edits`, {});
  const editUrl = `${API}/androidpublisher/v3/${app}/edits/${edit.id}`;
  const bundle = await call('POST', `${API}/upload/androidpublisher/v3/${app}/edits/${edit.id}/bundles?uploadType=media`,
    fs.readFileSync(aab), 'application/octet-stream');
  await call('PUT', `${editUrl}/tracks/${track}`, {
    track,
    releases: [{ name: version, versionCodes: [String(bundle.versionCode)], status: 'completed' }],
  });
  await call('POST', `${editUrl}:commit`);
  console.log(`Google Play: ${version} (versionCode ${bundle.versionCode}) released on ${track}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [aab, version] = process.argv.slice(2);
  if (!aab || !version) {
    console.error('usage: publish-play.mjs <signed-play.aab> <version>');
    process.exit(1);
  }
  publishPlay(path.resolve(aab), version).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
