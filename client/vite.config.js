import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: '/opt/voicaw-client',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'https://api.voicaw.com',
        changeOrigin: true,
      }
    },
    allowedHosts: true
  }
});
