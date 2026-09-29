// Starts a throwaway API and a client dev server for browser checks:
//   node e2e/serve.mjs            (web on :5199, API on :3099, object store on :3100;
//                                  E2E_WEB_PORT / E2E_API_PORT / E2E_S3_PORT)
// plus, for voice, its own LiveKit server (the binary at LIVEKIT_BIN, default
// ~/livekit/livekit-server; skipped if it isn't there) on E2E_LIVEKIT_PORT (default API + 2,
// with media on the next two ports), only on 127.0.0.1.
// Ctrl+C (or killing this process) stops all of them. Never use 5173 or 3002 (the live test
// site and API) or 7880-7882 (the live LiveKit).
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const webPort = process.env.E2E_WEB_PORT || '5199';
const apiPort = process.env.E2E_API_PORT || '3099';
const s3Port = process.env.E2E_S3_PORT || String(Number(apiPort) + 1);
const livekitPort = Number(process.env.E2E_LIVEKIT_PORT || Number(apiPort) + 2);
const livekitPorts = [livekitPort, livekitPort + 1, livekitPort + 2].map(String);
if ([webPort, apiPort, s3Port, ...livekitPorts].some((port) => ['5173', '3002', '7880', '7881', '7882'].includes(port))) {
  console.error('5173, 3002 and 7880-7882 are the live test site, API and LiveKit; pick other ports.');
  process.exit(1);
}
const livekitBin = process.env.LIVEKIT_BIN || join(homedir(), 'livekit', 'livekit-server');
const livekit = existsSync(livekitBin)
  ? { key: 'e2e', secret: randomBytes(24).toString('hex') }
  : null;
const root = fileURLToPath(new URL('..', import.meta.url));
const env = {
  ...process.env,
  E2E_WEB_PORT: webPort,
  E2E_API_PORT: apiPort,
  E2E_S3_PORT: s3Port,
  VITE_API_BASE_URL: '/api/',
  VITE_WS_URL: `ws://localhost:${webPort}/ws`,
  ...(livekit && {
    LIVEKIT_URL: `ws://localhost:${livekitPort}`,
    LIVEKIT_API_KEY: livekit.key,
    LIVEKIT_API_SECRET: livekit.secret,
  }),
};

// Vite run directly (not through npx), so stopping this stops it too.
const vitePackage = createRequire(`${root}/client/package.json`).resolve('vite/package.json');
const viteBin = vitePackage.replace(/package\.json$/, 'bin/vite.js');
const children = [
  spawn(process.execPath, ['e2e/start-api.mjs'], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, [viteBin, '--config', '../e2e/vite.config.mjs'], { cwd: `${root}/client`, env, stdio: 'inherit' }),
];
if (livekit) {
  const config = join(mkdtempSync(join(tmpdir(), 'voicaw-e2e-livekit-')), 'livekit.yaml');
  writeFileSync(config, [
    `port: ${livekitPort}`,
    'bind_addresses: ["127.0.0.1"]',
    'rtc:',
    `  tcp_port: ${livekitPort + 1}`,
    `  udp_port: ${livekitPort + 2}`,
    '  use_external_ip: false',
    '  node_ip: 127.0.0.1',
    '  enable_loopback_candidate: true',
    '  interfaces: { includes: [lo] }',
    `keys: { ${livekit.key}: ${livekit.secret} }`,
    'webhook:',
    `  api_key: ${livekit.key}`,
    `  urls: ["http://127.0.0.1:${apiPort}/api/livekit/webhook"]`,
    'logging: { level: warn }',
  ].join('\n'), { mode: 0o600 });
  children.push(spawn(livekitBin, ['--config', config], { stdio: 'inherit' }));
} else {
  console.log(`e2e: no LiveKit at ${livekitBin}, voice channels can't be joined.`);
}
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
console.log(`e2e: http://localhost:${webPort} (API :${apiPort}, object store :${s3Port}${livekit ? `, LiveKit :${livekitPort}` : ''})`);
