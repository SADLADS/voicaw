import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import { createRequire } from 'module';
import { SHEET_CELL, SHEET_COLUMNS, emojiSheets, sheetKey } from './src/emoji/emojiSheets.js';
import { twemojiFile } from './src/emoji/twemojiFile.js';

// Twemoji images, self-hosted at /emoji/<file>.svg (see src/emoji/emojiIndex.js): served
// straight from the npm package in dev, copied into the build output otherwise. Nothing to
// upload or configure for a new install, and browsers never contact a third party.
// The picker's sprite sheets (src/emoji/emojiSheets.js) are made from them with sharp, once
// per sheet key into Vite's cache folder, and served or copied at /emoji/sheets/<key>/.
function twemojiAssets() {
  const require = createRequire(import.meta.url);
  const svgDir = path.dirname(require.resolve('@twemoji/svg/package.json'));
  const key = sheetKey(require('@twemoji/svg/package.json').version, require('@emoji-mart/data/package.json').version);
  const isEmojiFile = (name) => /^[0-9a-f-]+\.svg$/.test(name);
  let cacheDir;
  let sheets = null;

  // Resolves to the folder holding every sheet of this key.
  function makeSheets() {
    sheets ??= (async () => {
      const dir = path.join(cacheDir, 'emoji-sheets', key);
      const done = path.join(dir, 'complete');
      if (fs.existsSync(done)) return dir;
      const { default: sharp } = await import('sharp');
      const data = require('@emoji-mart/data/sets/15/twitter.json');
      fs.mkdirSync(dir, { recursive: true });
      // Twemoji's SVGs are 36 units square; sharp draws them at 72 dpi, so 36px.
      const density = (72 * SHEET_CELL) / 36;
      for (const { name, cells } of emojiSheets(data)) {
        const tiles = await Promise.all(cells.map(async (unified, i) => ({
          input: await sharp(path.join(svgDir, `${twemojiFile(unified)}.svg`), { density }).resize(SHEET_CELL, SHEET_CELL).png().toBuffer(),
          left: (i % SHEET_COLUMNS) * SHEET_CELL,
          top: Math.floor(i / SHEET_COLUMNS) * SHEET_CELL,
        })));
        const size = { width: SHEET_COLUMNS * SHEET_CELL, height: Math.ceil(cells.length / SHEET_COLUMNS) * SHEET_CELL };
        await sharp({ create: { ...size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite(tiles)
          .webp({ quality: 90, alphaQuality: 100, effort: 4 })
          .toFile(path.join(dir, `${name}.webp`));
      }
      fs.writeFileSync(done, '');
      return dir;
    })();
    return sheets;
  }

  return {
    name: 'twemoji-assets',
    configResolved(config) {
      cacheDir = config.cacheDir;
    },
    configureServer(server) {
      // Start at once, so the first picker opened doesn't wait for them.
      makeSheets().catch((err) => server.config.logger.error(`Emoji sheets: ${err.message}`));
      server.middlewares.use('/emoji', (req, res, next) => {
        const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
        const sheet = name.match(/^sheets\/([^/]+)\/([a-z0-9]+\.webp)$/);
        if (sheet) {
          if (sheet[1] !== key) return next();
          makeSheets().then((dir) => {
            const file = path.join(dir, sheet[2]);
            if (!fs.existsSync(file)) return next();
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            fs.createReadStream(file).pipe(res);
          }, next);
          return undefined;
        }
        const file = path.join(svgDir, name);
        if (!isEmojiFile(name) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(file).pipe(res);
      });
    },
    async writeBundle(options) {
      const outDir = path.join(options.dir, 'emoji');
      fs.mkdirSync(outDir, { recursive: true });
      for (const name of fs.readdirSync(svgDir)) {
        if (isEmojiFile(name)) fs.copyFileSync(path.join(svgDir, name), path.join(outDir, name));
      }
      const from = await makeSheets();
      const to = path.join(outDir, 'sheets', key);
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        if (name.endsWith('.webp')) fs.copyFileSync(path.join(from, name), path.join(to, name));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isElectron = env.ELECTRON === 'true';
  // The desktop app talks to the real server: without a .env.electron, it uses the
  // production settings (.env.production).
  if (isElectron && !env.VITE_API_BASE_URL) {
    const production = loadEnv('production', process.cwd(), 'VITE_');
    for (const [key, value] of Object.entries(production)) process.env[key] ??= value;
    env.VITE_API_BASE_URL = production.VITE_API_BASE_URL;
  }

  console.log('Loaded ENV for mode:', mode);
  console.log('VITE_API_BASE_URL:', env.VITE_API_BASE_URL);

  return {
    // The desktop app serves the build at voicaw://app/ (electron/protocol.js), so absolute
    // paths work there too.
    base: '/',
    plugins: [
      react(),
      twemojiAssets(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'service-worker.js',
        // The app offers updates (UpdateBanner) rather than swapping versions under the user.
        registerType: 'prompt',
        includeAssets: ['favicon.ico', 'logo192.png', 'logo512.png', 'logo-maskable-512.png', 'apple-touch-icon.png', 'badge.png', 'default.png'],
        // The app links public/manifest.json itself (served as application/json; nginx has
        // no MIME type for .webmanifest), so don't generate a second manifest.
        manifest: false,
        // Serve the real service worker from the dev server too, so push notifications can
        // be tested on test.voicaw.com (which runs `vite dev`).
        devOptions: {
          enabled: true,
          type: 'module',
        },
      })
    ],
    define: {
      // Shown in Settings, to tell which version a device is running.
      'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
    },
    build: {
      outDir: isElectron
        ? path.resolve(__dirname, '../build')
        : '/opt/voicaw-client',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/api': {
          target: 'https://api.voicaw.com',
          changeOrigin: true,
        },
      },
      allowedHosts: true,
    },
  };
});
