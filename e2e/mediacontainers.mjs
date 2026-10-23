// Throwaway Jellyfin and Emby servers in Docker for e2e/mediaservers.mjs: each on 127.0.0.1
// (E2E_JELLYFIN_PORT 18096, E2E_EMBY_PORT 18097), with two made-up videos (ffmpeg): "Test Clip"
// (H.264/AAC MP4, played as it is) and "Hevc Film" (HEVC/AC-3 MKV, which browsers can't play:
// transcoded to HLS), an administrator "admin" and an ordinary account "guild", passwords
// "adminpw" and "guildpw". Kept in E2E_MEDIA_DIR (default /tmp/voicaw-e2e-media) and reused
// on the next run; `node e2e/mediacontainers.mjs stop` removes the containers (each capped at
// 1 GB of memory).
//   node e2e/mediacontainers.mjs   then   node e2e/mediaservers.mjs [screenshot dir]
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const dir = process.env.E2E_MEDIA_DIR || '/tmp/voicaw-e2e-media';
const SERVERS = [
  { kind: 'jellyfin', name: 'voicaw-e2e-jellyfin', image: 'jellyfin/jellyfin:10.10.7', port: process.env.E2E_JELLYFIN_PORT || '18096', api: '' },
  { kind: 'emby', name: 'voicaw-e2e-emby', image: 'emby/embyserver:4.8.11.0', port: process.env.E2E_EMBY_PORT || '18097', api: '/emby' },
];
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === 'stop') {
  for (const { name } of SERVERS) {
    try {
      run('docker', ['rm', '-f', name]);
      console.log(`removed ${name}`);
    } catch {
      // Not there.
    }
  }
  process.exit(0);
}

const movies = join(dir, 'media', 'movies');
mkdirSync(movies, { recursive: true });
const clip = join(movies, 'Test Clip (2020).mp4');
if (!existsSync(clip)) {
  run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '60', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
}
const film = join(movies, 'Hevc Film (2021).mkv');
if (!existsSync(film)) {
  run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660',
    '-t', '90', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', film]);
}

const uid = String(process.getuid());
const gid = String(process.getgid());

async function call(server, path, { method = 'GET', body, token } = {}) {
  const scheme = server.kind === 'emby' ? 'Emby' : 'MediaBrowser';
  const res = await fetch(`http://127.0.0.1:${server.port}${server.api}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': `${scheme} Client="e2e", Device="e2e", DeviceId="voicaw-e2e", Version="1"`,
      ...(token && { 'X-Emby-Token': token }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${server.kind} ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const login = (server, username, password) => call(server, '/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } });

for (const server of SERVERS) {
  const config = join(dir, server.kind);
  mkdirSync(config, { recursive: true });
  const running = run('docker', ['ps', '-a', '--filter', `name=^${server.name}$`, '--format', '{{.State}}']);
  if (running !== 'running') {
    if (running) run('docker', ['rm', '-f', server.name]);
    const user = server.kind === 'jellyfin' ? ['--user', `${uid}:${gid}`, '-v', `${config}:/config`, '-v', `${join(dir, 'cache')}:/cache`] : ['-e', `UID=${uid}`, '-e', `GID=${gid}`, '-v', `${config}:/config`];
    mkdirSync(join(dir, 'cache'), { recursive: true });
    run('docker', ['run', '-d', '--name', server.name, '--memory', '1g', '-p', `127.0.0.1:${server.port}:8096`,
      ...user, '-v', `${join(dir, 'media')}:/media:ro`, server.image]);
  }
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    info = await call(server, '/System/Info/Public').catch(() => null);
    if (!info) await sleep(2000);
  }
  if (!info) throw new Error(`${server.kind} didn't start`);

  if (info.StartupWizardCompleted !== true && !(await login(server, 'admin', 'adminpw').catch(() => null))) {
    await call(server, '/Startup/Configuration', { method: 'POST', body: { UICulture: 'en-US', MetadataCountryCode: 'GB', PreferredMetadataLanguage: 'en' } });
    await call(server, '/Startup/User');
    await call(server, '/Startup/User', { method: 'POST', body: { Name: 'admin', Password: 'adminpw' } });
    await call(server, '/Startup/Complete', { method: 'POST' });
  }
  const { AccessToken: token } = await login(server, 'admin', 'adminpw');
  const folders = await call(server, '/Library/VirtualFolders', { token });
  if (!folders.some((f) => f.Name === 'Movies')) {
    await call(server, '/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=true&paths=%2Fmedia%2Fmovies', {
      method: 'POST', token, body: { LibraryOptions: { PathInfos: [{ Path: '/media/movies' }] } },
    });
  }
  if (!(await login(server, 'guild', 'guildpw').catch(() => null))) {
    const created = await call(server, '/Users/New', { method: 'POST', token, body: { Name: 'guild', Password: 'guildpw' } });
    // Emby ignores a new account's password.
    if (server.kind === 'emby') await call(server, `/Users/${created.Id}/Password`, { method: 'POST', token, body: { NewPw: 'guildpw', CurrentPw: '' } });
  }
  // Until both videos are in the library.
  for (let i = 0; i < 60; i++) {
    const items = await call(server, '/Items?Recursive=true&IncludeItemTypes=Movie', { token });
    if (items.Items.length >= 2) break;
    await sleep(2000);
  }
  console.log(`${server.kind}: http://127.0.0.1:${server.port} (${info.ServerName}, ${info.Version})`);
}
