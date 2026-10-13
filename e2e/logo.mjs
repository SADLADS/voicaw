// The rail's bird logo: every click plays the Philly hit (Sounds' Logo), quick clicks each get
// their own, it doesn't clip, the page doesn't move, and Settings → Sounds has its switch (off =
// silent). Web Audio is tapped in the page: oscillators counted, the output's peak measured.
//   node e2e/serve.mjs &   then   node e2e/logo.mjs [dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const dir = process.argv[2];
const browser = await launchChrome({ args: ['--autoplay-policy=no-user-gesture-required'] });

// Counts oscillators and routes everything bound for the speakers through an analyser.
async function tapAudio(page) {
  await page.evaluate(() => {
    window.__osc = 0;
    window.__peak = 0;
    const createOscillator = BaseAudioContext.prototype.createOscillator;
    BaseAudioContext.prototype.createOscillator = function () {
      window.__osc += 1;
      return createOscillator.call(this);
    };
    const connect = AudioNode.prototype.connect;
    const analysers = new WeakMap();
    AudioNode.prototype.connect = function (target, ...rest) {
      if (target instanceof AudioDestinationNode) {
        const ctx = target.context;
        if (!analysers.has(ctx)) {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          connect.call(analyser, target);
          analysers.set(ctx, analyser);
          const data = new Float32Array(analyser.fftSize);
          setInterval(() => {
            analyser.getFloatTimeDomainData(data);
            for (const v of data) window.__peak = Math.max(window.__peak, Math.abs(v));
          }, 10);
        }
        return connect.call(this, analysers.get(ctx), ...rest);
      }
      return connect.call(this, target, ...rest);
    };
  });
}

const audio = (page) => page.evaluate(() => ({ osc: window.__osc, peak: window.__peak }));

try {
  const alice = await signUp(browser, 'alice');
  const { page } = alice;
  await tapAudio(page);
  const url = page.url();
  const logo = page.locator('img.rail-logo');

  await logo.click();
  await page.waitForTimeout(1000);
  const one = await audio(page);
  // 7 notes, two detuned oscillators each.
  if (one.osc !== 14) throw new Error(`one click made ${one.osc} oscillators, not 14`);
  if (one.peak < 0.05) throw new Error(`the hit was silent (peak ${one.peak})`);
  if (one.peak > 1) throw new Error(`the hit clips (peak ${one.peak})`);
  console.log(`one click: 14 oscillators, peak ${one.peak.toFixed(2)}`);
  if (dir) await page.screenshot({ path: `${dir}/logo-rail.png` });

  // Quick clicks each play.
  await logo.click();
  await logo.click();
  await logo.click();
  await page.waitForTimeout(1000);
  const quick = await audio(page);
  if (quick.osc !== 14 * 4) throw new Error(`3 quick clicks made ${quick.osc - 14} oscillators, not 42`);
  if (quick.peak > 1) throw new Error(`overlapping hits clip (peak ${quick.peak})`);
  console.log(`three quick clicks: three hits, peak ${quick.peak.toFixed(2)}`);
  if (page.url() !== url) throw new Error(`the logo navigated to ${page.url()}`);

  // Settings → Notifications → Sounds lists it; switched off, clicks are silent.
  await page.goto(`${BASE}/settings/notifications`);
  const row = page.locator('text=You click the Voicaw bird');
  await row.waitFor({ timeout: 10000 });
  if (dir) await page.screenshot({ path: `${dir}/logo-settings.png`, fullPage: true });
  await page.evaluate(() => localStorage.setItem('soundPrefs', JSON.stringify({ volume: 1, off: ['logo'] })));
  await page.goto(url);
  await tapAudio(page);
  await logo.click();
  await page.waitForTimeout(500);
  if ((await audio(page)).osc !== 0) throw new Error('the logo played with Logo switched off');
  console.log('Settings → Sounds has Logo; off = silent');

  console.log('logo: ok');
} catch (err) {
  console.error('logo: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
