// Starts a throwaway API and a client dev server for browser checks:
//   node e2e/serve.mjs            (web on :5199, API on :3099, object store on :3100;
//                                  E2E_WEB_PORT / E2E_API_PORT / E2E_S3_PORT)
// Ctrl+C (or killing this process) stops both. Never use 5173 or 3002: those are the live
// test site and API.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const webPort = process.env.E2E_WEB_PORT || '5199';
const apiPort = process.env.E2E_API_PORT || '3099';
const s3Port = process.env.E2E_S3_PORT || String(Number(apiPort) + 1);
if ([webPort, apiPort, s3Port].some((port) => ['5173', '3002'].includes(port))) {
  console.error('5173 and 3002 are the live test site and API; pick other ports.');
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const env = {
  ...process.env,
  E2E_WEB_PORT: webPort,
  E2E_API_PORT: apiPort,
  E2E_S3_PORT: s3Port,
  VITE_API_BASE_URL: '/api/',
  VITE_WS_URL: `ws://localhost:${webPort}/ws`,
};

// Vite run directly (not through npx), so stopping this stops it too.
const vitePackage = createRequire(`${root}/client/package.json`).resolve('vite/package.json');
const viteBin = vitePackage.replace(/package\.json$/, 'bin/vite.js');
const children = [
  spawn(process.execPath, ['e2e/start-api.mjs'], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, [viteBin, '--config', '../e2e/vite.config.mjs'], { cwd: `${root}/client`, env, stdio: 'inherit' }),
];
const stop = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((c) => c.on('exit', (code) => {
  console.error(`e2e: a server exited (${code}); stopping.`);
  stop();
}));
console.log(`e2e: http://localhost:${webPort} (API :${apiPort}, object store :${s3Port})`);
