// The client dev server for browser checks, talking to e2e/start-api.mjs (see serve.mjs).
import { fileURLToPath } from 'url';
import base from '../client/vite.config.js';

const apiPort = process.env.E2E_API_PORT || '3099';
const webPort = Number(process.env.E2E_WEB_PORT || 5199);
// The API only accepts voicaw.com origins; the proxy makes requests same-origin instead.
const dropOrigin = (event) => (proxy) => proxy.on(event, (req) => req.removeHeader('origin'));

export default async (env) => {
  const config = await base(env);
  config.root = fileURLToPath(new URL('../client', import.meta.url));
  config.server = {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, configure: dropOrigin('proxyReq') },
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true, configure: dropOrigin('proxyReqWs') },
    },
  };
  return config;
};
