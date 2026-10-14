// TURN over TLS on 443 beside nginx (see TURN in docs/voice-and-calls.md), on its own: no
// serve.mjs needed. Starts a LiveKit with TURN (external_tls) and an unprivileged nginx with
// server/scripts/turn-443.sh's stream split (a self-signed certificate; E2E_TURN_PORT, default
// 3120, and the next seven ports; nginx at NGINX_BIN, default /usr/sbin/nginx). Checks: HTTPS
// for another name still reaches the sites, with the visitor's address (PROXY protocol);
// LiveKit tells clients turns:<domain>:443; two Chromes allowed relayed paths only (as on a
// network that blocks UDP and TCP 7881) join, and one hears the other through TURN over TLS.
//   node e2e/turn.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { build } from 'esbuild';
import { launchChrome, fakeMicArgs } from './helpers.mjs';

const base = Number(process.env.E2E_TURN_PORT || 3120);
const [lkPort, lkTcp, lkUdp, turnPort, port443, sitesPort, turnTlsPort, pagePort] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => base + i);
if ([lkPort, lkTcp, lkUdp, turnPort, port443, sitesPort, turnTlsPort, pagePort].some((p) => [3002, 5173, 7880, 7881, 7882, 7883].includes(p))) {
  console.error('3002, 5173 and 7880-7883 are live; pick another E2E_TURN_PORT.');
  process.exit(1);
}
const livekitBin = process.env.LIVEKIT_BIN || join(homedir(), 'livekit', 'livekit-server');
const nginxBin = process.env.NGINX_BIN || '/usr/sbin/nginx';
const domain = 'turn.voicaw.test';
const dir = mkdtempSync(join(tmpdir(), 'voicaw-e2e-turn-'));
const key = 'turn-test';
const secret = randomBytes(24).toString('hex');
const children = [];
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const stop = () => {
  for (const c of children) c.kill();
  try { execFileSync(nginxBin, ['-p', dir, '-c', join(dir, 'nginx.conf'), '-e', join(dir, 'error.log'), '-s', 'stop'], { stdio: 'ignore' }); } catch { /* not started */ }
};

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${domain}`,
  '-addext', `subjectAltName=DNS:${domain},DNS:app.voicaw.test`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });

// As production's livekit.yaml, on loopback. Production needs no allow_restricted_peer_cidrs:
// its relay reaches the SFU's public address (the router loops back); here the SFU is 127.0.0.1.
writeFileSync(join(dir, 'livekit.yaml'), [
  `port: ${lkPort}`,
  'bind_addresses: ["127.0.0.1"]',
  'rtc:',
  `  tcp_port: ${lkTcp}`,
  `  udp_port: ${lkUdp}`,
  '  use_external_ip: false',
  '  node_ip: 127.0.0.1',
  '  enable_loopback_candidate: true',
  '  interfaces: { includes: [lo] }',
  'turn:',
  '  enabled: true',
  `  domain: ${domain}`,
  `  tls_port: ${turnPort}`,
  '  external_tls: true',
  '  udp_port: 0',
  '  allow_restricted_peer_cidrs: ["127.0.0.1/32"]',
  `keys: { ${key}: ${secret} }`,
  'logging: { level: warn }',
].join('\n'), { mode: 0o600 });

// turn-443.sh's stream block, with the sites' side standing in for /etc/nginx/sites-enabled.
mkdirSync(join(dir, 'tmp'));
const certs = `ssl_certificate ${join(dir, 'cert.pem')}; ssl_certificate_key ${join(dir, 'key.pem')};`;
writeFileSync(join(dir, 'nginx.conf'), `
load_module /usr/lib/nginx/modules/ngx_stream_module.so;
worker_processes 1;
pid ${join(dir, 'nginx.pid')};
events {}
stream {
  map $ssl_preread_server_name $tls_443_backend { ${domain} 127.0.0.1:${turnTlsPort}; default 127.0.0.1:${sitesPort}; }
  server { listen 127.0.0.1:${port443}; ssl_preread on; proxy_pass $tls_443_backend; proxy_protocol on; proxy_timeout 1d; }
  server { listen 127.0.0.1:${turnTlsPort} ssl proxy_protocol; ${certs} ssl_protocols TLSv1.2 TLSv1.3; proxy_pass 127.0.0.1:${turnPort}; proxy_timeout 1h; }
}
http {
  access_log off;
  ${['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((t) => `${t}_temp_path ${join(dir, 'tmp')};`).join(' ')}
  set_real_ip_from 127.0.0.1;
  real_ip_header proxy_protocol;
  server { listen 127.0.0.1:${sitesPort} ssl proxy_protocol; server_name app.voicaw.test; ${certs} location / { return 200 "ip=$remote_addr"; } }
}`);

try {
  execFileSync(nginxBin, ['-p', dir, '-c', join(dir, 'nginx.conf'), '-e', join(dir, 'error.log')]);
  children.push(spawn(livekitBin, ['--config', join(dir, 'livekit.yaml')], { stdio: 'inherit' }));

  // The sites behind the split see who connected (here from 127.0.0.2).
  const site = execFileSync('curl', ['-sk', '--interface', '127.0.0.2', '--resolve', `app.voicaw.test:${port443}:127.0.0.1`,
    `https://app.voicaw.test:${port443}/`]).toString();
  check(site === 'ip=127.0.0.2', `HTTPS for other names reaches the sites, with the visitor's address (${site})`);

  // livekit-client as the app uses it, and a page that only allows relayed paths: LiveKit's
  // turns:…:443 is pointed at the stand-in 443 (the name resolves to 127.0.0.1).
  const lk = (await build({
    stdin: { contents: "export * from 'livekit-client';", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true, format: 'iife', globalName: 'LivekitClient', write: false, logLevel: 'error',
  })).outputFiles[0].text;
  const page = `<!doctype html><meta charset="utf-8"><script>
    const Orig = RTCPeerConnection, told = [], pcs = [];
    const relayOnly = (cfg = {}) => {
      told.push(...(cfg.iceServers || []).flatMap((s) => [].concat(s.urls)));
      const iceServers = (cfg.iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).map((u) => u.replace(':443', ':${port443}')) }));
      return { ...cfg, iceServers, iceTransportPolicy: 'relay' };
    };
    window.RTCPeerConnection = function (cfg, ...rest) { const pc = new Orig(relayOnly(cfg), ...rest); pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Orig.prototype;
    const set = Orig.prototype.setConfiguration;
    Orig.prototype.setConfiguration = function (cfg) { return set.call(this, relayOnly(cfg)); };
    window.told = told;
    window.paths = async () => {
      const out = [];
      for (const pc of pcs) {
        const stats = await pc.getStats(), byId = new Map([...stats.values()].map((s) => [s.id, s]));
        for (const s of stats.values()) {
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
            const local = byId.get(s.localCandidateId);
            out.push({ type: local.candidateType, protocol: local.relayProtocol });
          }
          if (s.type === 'inbound-rtp' && s.kind === 'audio') out.push({ audioPackets: s.packetsReceived });
        }
      }
      return out;
    };
  </script><script src="/lk.js"></script><script>
    window.join = async (token, publish) => {
      const room = new LivekitClient.Room();
      await room.connect('ws://127.0.0.1:${lkPort}', token);
      if (publish) await room.localParticipant.setMicrophoneEnabled(true);
    };
  </script>`;
  const http = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/lk.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/lk.js' ? lk : page);
  }).listen(pagePort, '127.0.0.1');

  const token = (identity) => {
    const t = new AccessToken(key, secret, { identity });
    t.addGrant({ roomJoin: true, room: 'turn' });
    return t.toJwt();
  };
  await new Promise((r) => setTimeout(r, 1000)); // LiveKit starting
  const browser = await launchChrome({ args: [...fakeMicArgs(), `--host-resolver-rules=MAP ${domain} 127.0.0.1`, '--ignore-certificate-errors'] });
  const open = async (name, publish) => {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`http://127.0.0.1:${pagePort}/`);
    await p.evaluate(([t, pub]) => window.join(t, pub), [await token(name), publish]);
    return p;
  };
  try {
    const speaker = await open('speaker', true);
    const listener = await open('listener', false);
    const told = await listener.evaluate(() => window.told);
    check(told.includes(`turns:${domain}:443?transport=tcp`), `LiveKit tells clients turns:${domain}:443 (${told.filter((u) => u.startsWith('turn')).join(', ')})`);
    await new Promise((r) => setTimeout(r, 5000));
    const heard = await listener.evaluate(() => window.paths());
    const sent = await speaker.evaluate(() => window.paths());
    const relayed = (paths) => paths.some((p) => p.type === 'relay' && p.protocol === 'tls');
    check(relayed(sent) && relayed(heard), `both connect through TURN over TLS (${JSON.stringify(sent.concat(heard).filter((p) => p.type))})`);
    const packets = heard.find((p) => p.audioPackets)?.audioPackets || 0;
    check(packets > 100, `the listener hears the speaker through it (${packets} audio packets in 5 s)`);
  } finally {
    await browser.close();
    http.close();
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
