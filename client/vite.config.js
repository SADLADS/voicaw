import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  console.log('Loaded ENV for mode:', mode);
  console.log('VITE_API_BASE_URL:', env.VITE_API_BASE_URL);

  const isElectron = env.ELECTRON === 'true';

  return {
    base: isElectron ? './' : '/',
    plugins: [
      react(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'service-worker.js',
        registerType: 'autoUpdate',
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
