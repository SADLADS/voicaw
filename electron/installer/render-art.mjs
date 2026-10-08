// Draws the Windows installer's pictures (installer.nsh) from the splash window's page
// (assets/splash.html?installer-art), so the two look the same: splash.bmp at 300×340 and
// splash@2x.bmp at 600×680, 256 colours (NSIS shows BMPs only; keeps them small). Run it after
// changing the splash's look, and commit the BMPs:
//   node electron/installer/render-art.mjs
// Prints where the splash puts its line and detail, which installer.nsh's layout copies.
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(here, '..', 'assets', 'splash.html')).href;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
try {
  for (const [scale, name] of [[1, 'splash.bmp'], [2, 'splash@2x.bmp']]) {
    const tab = await browser.newPage({ viewport: { width: 300, height: 340 }, deviceScaleFactor: scale });
    await tab.emulateMedia({ reducedMotion: 'reduce' });
    await tab.goto(`${page}?square&installer-art`);
    await tab.waitForFunction(() => document.querySelector('.bird').complete);
    await tab.waitForTimeout(500); // the card's fade in
    if (scale === 1) {
      const boxes = await tab.evaluate(() => ['text', 'detail'].map((id) => {
        const { top, height } = document.getElementById(id).getBoundingClientRect();
        return `${id}: top ${Math.round(top)}, height ${Math.round(height)}`;
      }));
      console.log(boxes.join('\n'));
    }
    const png = join(here, `${name}.png`);
    await tab.screenshot({ path: png });
    execFileSync('convert', [png, '-dither', 'FloydSteinberg', '-colors', '256', `BMP3:${join(here, name)}`]);
    execFileSync('rm', [png]);
    await tab.close();
  }
} finally {
  await browser.close();
}
