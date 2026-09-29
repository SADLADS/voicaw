import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import { createRequire } from 'module';

// Twemoji images, self-hosted at /emoji/<file>.svg (see src/emoji/emojiIndex.js): served
// straight from the npm package in dev, copied into the build output otherwise. Nothing to
// upload or configure for a new install, and browsers never contact a third party.
function twemojiAssets() {
  const svgDir = path.dirname(createRequire(import.meta.url).resolve('@twemoji/svg/package.json'));
  const isEmojiFile = (name) => /^[0-9a-f-]+\.svg$/.test(name);
  return {
    name: 'twemoji-assets',
    configureServer(server) {
      server.middlewares.use('/emoji', (req, res, next) => {
        const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
        const file = path.join(svgDir, name);
        if (!isEmojiFile(name) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      const outDir = path.join(options.dir, 'emoji');
      fs.mkdirSync(outDir, { recursive: true });
      for (const name of fs.readdirSync(svgDir)) {
        if (isEmojiFile(name)) fs.copyFileSync(path.join(svgDir, name), path.join(outDir, name));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  console.log('Loaded ENV for mode:', mode);
  console.log('VITE_API_BASE_URL:', env.VITE_API_BASE_URL);

  const isElectron = env.ELECTRON === 'true';

  return {
    base: isElectron ? './' : '/',
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
