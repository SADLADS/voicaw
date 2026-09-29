// Helpers for browser checks against e2e/serve.mjs. Scripts import these and use Playwright
// (playwright-core, driving the system Chrome); see e2e/smoke.mjs.
import { chromium, devices } from 'playwright-core';

export { devices };
export const BASE = `http://localhost:${process.env.E2E_WEB_PORT || 5199}`;

export function launchChrome(options = {}) {
  return chromium.launch({ executablePath: '/usr/bin/google-chrome', ...options });
}

// Registers a new user (names get a unique suffix; the database lives as long as serve.mjs)
// in its own browser context and returns { page, name, id }. `contextOptions` can be e.g.
// devices['Pixel 7'] for a phone.
export async function signUp(browser, name, contextOptions = { viewport: { width: 1100, height: 750 } }) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  const username = `${name}${String(Date.now()).slice(-5)}`;
  await page.goto(`${BASE}/`);
  await page.fill('input[placeholder="New Username"]', username);
  await page.fill('input[placeholder="New Password"]', `correct horse battery ${name}`);
  await page.click('button:has-text("Register")');
  // Registering logs in and redirects into the app: wait for that to finish.
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).id;
  });
  return { page, name: username, id };
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
