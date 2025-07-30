import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  console.log('🧪 Loaded ENV for mode:', mode);
  console.log('👉 VITE_API_BASE_URL:', env.VITE_API_BASE_URL);

  const isElectron = env.ELECTRON === 'true';

  return {
    base: isElectron ? './' : '/',
    plugins: [react()],
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
