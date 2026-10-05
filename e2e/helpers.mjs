// Helpers for browser checks against e2e/serve.mjs. Scripts import these and use Playwright
// (playwright-core, driving the system Chrome); see e2e/smoke.mjs.
import { chromium, devices } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export { devices };
export const BASE = `http://localhost:${process.env.E2E_WEB_PORT || 5199}`;

// The system Chrome (`CHROME_PATH` elsewhere than the server's, e.g. on Windows or macOS).
export function launchChrome(options = {}) {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', ...options });
}

// Registers a new user (names get a unique suffix; the database lives as long as serve.mjs)
// in its own browser context and returns { page, name, id, password, recoveryCode }.
// `contextOptions` can be e.g. devices['Pixel 7'] for a phone.
export async function signUp(browser, name, contextOptions = { viewport: { width: 1100, height: 750 } }) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  const username = `${name}${String(Date.now()).slice(-5)}`;
  await page.goto(`${BASE}/`);
  await page.fill('input[placeholder="New Username"]', username);
  await page.fill('input[placeholder="New Password"]', `correct horse battery ${name}`);
  // The terms of use tick (Login.jsx): registering needs it.
  await page.check('label:has-text("I agree to the") input');
  await page.click('button:has-text("Register")');
  // Then the new recovery code is shown (kept as `recoveryCode`) until it's confirmed saved.
  const recoveryCode = (await page.textContent('[aria-label="Recovery code"]', { timeout: 20000 })).trim();
  await page.check('text=I\'ve saved my recovery code');
  await page.click('button:has-text("Continue")');
  // Registering logs in and redirects into the app: wait for that to finish.
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).id;
  });
  return { page, name: username, id, password: `correct horse battery ${name}`, recoveryCode };
}

// Opens the conversation with user `otherId` and waits for the message box.
export async function openChat(page, otherId) {
  await page.goto(`${BASE}/dm/${otherId}`);
  await page.waitForSelector('#dm-input');
}

// Types into the message box (a contenteditable editor) and sends with Enter (desktop).
export async function send(page, text) {
  await page.click('#dm-input');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}


// Chrome flags for a fake microphone and camera that need no permission prompt. The
// microphone plays a speech-like sound (voiced syllables with pauses, made up here): Chrome's
// own fake input is a steady beep, which its noise suppression removes, so it never counts as
// someone talking. `phrases`: talking for 1.5 s, then silent for 1.5 s (PHRASE_SECONDS), over
// and over, instead of almost without a break.
export const PHRASE_SECONDS = 1.5;
export function fakeMicArgs({ phrases = false } = {}) {
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${speechLikeWav({ phrases })}`,
    '--autoplay-policy=no-user-gesture-required',
  ];
}

const speechFiles = new Map();
function speechLikeWav({ phrases }) {
  if (speechFiles.has(phrases)) return speechFiles.get(phrases);
  const rate = 48000;
  const seconds = phrases ? 4 * PHRASE_SECONDS : 8;
  const samples = new Int16Array(rate * seconds);
  let phase = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    // Syllables of ~0.25 s, a pause every fourth one; the pitch wanders like a voice.
    const syllable = Math.floor(t * 4);
    const within = (t * 4) % 1;
    const silent = syllable % 4 === 3 || (phrases && t % (2 * PHRASE_SECONDS) >= PHRASE_SECONDS);
    const envelope = silent ? 0 : Math.sin(Math.PI * within) ** 2;
    const pitch = 120 + 40 * Math.sin(2 * Math.PI * 0.7 * t) + 15 * Math.sin(2 * Math.PI * 3.1 * t);
    phase += (2 * Math.PI * pitch) / rate;
    // Harmonics shaped by two "formants" that move between vowels.
    const f1 = 500 + 300 * Math.sin(2 * Math.PI * 0.9 * t + syllable);
    const f2 = 1500 + 700 * Math.cos(2 * Math.PI * 0.6 * t + syllable);
    let value = 0;
    for (let h = 1; h * pitch < 4000; h++) {
      const f = h * pitch;
      const gain = Math.exp(-(((f - f1) / 250) ** 2)) + 0.6 * Math.exp(-(((f - f2) / 350) ** 2)) + 0.05;
      value += (gain / h ** 0.5) * Math.sin(h * phase);
    }
    samples[i] = Math.max(-32767, Math.min(32767, value * envelope * 6000));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.byteLength, 40);
  const file = join(mkdtempSync(join(tmpdir(), 'voicaw-e2e-mic-')), 'speech.wav');
  writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
  speechFiles.set(phrases, file);
  return file;
}

// Where serve.mjs leaves its LiveKit's address and keys ({ url, key, secret }).
export function livekitInfoPath(apiPort = process.env.E2E_API_PORT || '3099') {
  return join(tmpdir(), `voicaw-e2e-livekit-${apiPort}.json`);
}
