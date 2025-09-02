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
        includeAssets: ['favicon.ico', 'robots.txt', 'logo192.png', 'logo512.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Voicaw',
          short_name: 'Voicaw',
          description: 'Voicaw',
          theme_color: '#66558c',
          background_color: '#232329',
          display: 'standalone',
          icons: [
            { src: 'logo192.png', sizes: '192x192', type: 'image/png' },
            { src: 'logo512.png', sizes: '512x512', type: 'image/png' }
          ]
        }
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
