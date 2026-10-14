// The web app opening with no network at all (Offline copy, docs/messages.md): needs a
// production build, whose service worker serves the app's page when a page load fails. Writes a
// note, cuts the browser off entirely (the page too, not just the API), reloads on a chat's
// address: offline mode with the note. Build and serve it beside serve.mjs (any free port):
//   E2E_WEB_PORT=5232 VITE_API_BASE_URL=/api/ VITE_WS_URL=ws://localhost:5232/ws \
//     npx vite build --config e2e/vite.config.mjs --outDir /tmp/<dir> --emptyOutDir
//   E2E_WEB_PORT=5232 npx vite preview --config e2e/vite.config.mjs --outDir /tmp/<dir> --port 5232 &
//   E2E_WEB_PORT=5232 node e2e/offlinepwa.mjs [screenshot dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
const browser = await launchChrome();
try {
  const { page } = await signUp(browser, 'pwa');
  await page.goto(`${BASE}/dm/notes`);
  await page.waitForSelector('#dm-input[contenteditable="true"]');
  await page.click('#dm-input');
  await page.keyboard.type('note without a network');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dm-message:not(.pending) >> text=note without a network');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
  await page.waitForTimeout(2000); // the note saved in the offline copy

  await page.context().setOffline(true);
  await page.goto(`${BASE}/dm/notes`);
  await page.waitForSelector('.offline-banner', { timeout: 20000 });
  await page.waitForSelector('.dm-message >> text=note without a network');
  if (shots) await page.screenshot({ path: `${shots}/pwa-offline.png` });
  console.log('offlinepwa: OK (page from the service worker, note from the copy)');
} catch (err) {
  if (shots) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: `${shots}/pwa-fail.png` }).catch(() => {});
  console.error('offlinepwa: FAILED', err.message.split('\n').slice(0, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close();
}
