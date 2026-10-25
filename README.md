# voicaw

A Discord-style chat app: end-to-end encrypted direct messages, and guilds (Discord-style servers) with
text and voice channels. See `CLAUDE.md` and `docs/` for how it works and how to develop on it.

## Building the apps yourself

You don't need to: the desktop app is on [voicaw.com](https://voicaw.com) and the Android app on
Google Play. But if you'd rather run a copy built from this code (to check that it's the code
you've read, for example), here's how. Your build talks to the real Voicaw (app.voicaw.com), and
you log in with your usual account.

### What you need

- [git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 24 (it comes with npm 11).
- For Android: [Docker](https://docs.docker.com/get-docker/) (the Android SDK runs inside it,
  so nothing else is installed). On Windows, use WSL 2.
- For the Windows desktop installer built on Linux: Docker too.
- About 5 GB of disk for Android (the build image and Gradle's downloads), 1 GB for desktop.

### 1. Get the code

```sh
git clone https://github.com/SADLADS/voicaw.git && cd voicaw
git checkout master  # the branch the live app runs
npm install
```

### 2. Point it at Voicaw

The build needs to know where the server is. Create `client/.env.production` with:

```ini
VITE_API_BASE_URL=https://app.voicaw.com/api/
VITE_WS_URL=wss://api.voicaw.com
```

(The slash at the end of the first line matters. To use your own server instead, see Initial
setup below.)

### 3a. Desktop (Linux, Windows, macOS)

```sh
npm run dist:electron
```

The installers land in `dist-desktop/`, for the system you built on:

- **Linux:** an AppImage (make it executable and run it) and a `.deb`
  (`sudo apt install ./dist-desktop/voicaw-desktop_*.deb`).
- **Windows:** the installer `.exe`. It isn't signed, so SmartScreen warns the first time
  ("More info" → "Run anyway"). On Linux you can build it with `npm run dist:electron:win`
  (in Docker).
- **macOS:** a `.dmg`. It isn't signed either: the first time, right-click the app →
  Open. Building for macOS needs a Mac.

The desktop app updates itself from updates.voicaw.com, so at its first start your copy would
be replaced by the official release. To keep running your own build, build it with automatic
updates off (Settings → Desktop App → Update automatically starts unticked, and the app only
asks updates.voicaw.com when you press Check for updates), then update by building again:

```sh
VOICAW_AUTO_UPDATE=off npm run dist:electron
```

Official desktop releases are built by GitHub from the tagged commit, not on Voicaw's server
(`.github/workflows/desktop-release.yml`), and every file is attested. To check that an
installer you downloaded came from that workflow, and which commit it was built from:

```sh
gh attestation verify Voicaw-1.2.3.AppImage --repo SADLADS/voicaw
```

### 3b. Android

```sh
npm run dist:android
```

The first run builds the Docker image and downloads Gradle's packages, which takes a while.
The app ends up in `dist-android/voicaw-debug.apk`. Copy it to the phone and open it
(Android asks once to allow installs from wherever you opened it), or with the phone plugged
in and USB debugging on: `adb install dist-android/voicaw-debug.apk`.

Two differences from the Play Store app:

- **It's signed with your own key**, so Android won't install it over the Play Store copy, or
  the other way round. Uninstall one first. That logs you out of that copy, and logging in again
  brings your messages back as usual.
- **There are no notifications while the app is closed.** Those go through Voicaw's Firebase
  project, which only the official app is part of. While it's open, notifications and calls work
  as usual.

### 3c. The web app, to work on it

To change the web app and see it as you go, against the real Voicaw: create
`client/.env.development` with

```ini
VITE_API_BASE_URL=/api/
VITE_WS_URL=wss://api.voicaw.com
```

then run `npm run dev` and open http://localhost:5173. The dev server forwards `/api` to
api.voicaw.com (`client/vite.config.js`) and reloads the page as you save. You log in with your
usual account, and everything you do is real: real people see your messages. Only the web app
is yours, so a change that needs something new on the server won't work until the server has
it. Before sending changes, run `npm run lint` and `npm test` in `client/`.

## Initial setup

How a fresh host is set up, in order. The live host is set up like this: the API and the test
site run from a checkout of `master` under pm2, the web app at app.voicaw.com is a static build in
`/opt/voicaw-client`, voicaw.com is an info and download site (`website/`, section 10), and nginx
handles TLS for all of them.

### 1. Requirements

- Node 24 LTS and npm 11.
- An S3-compatible object store (e.g. MinIO) for uploads, profile pictures, guild icons,
  emoji and soundboard sounds. The server creates its buckets (`uploads`, `profile-pics`,
  `guild-icons`, `emojis`, `sounds`) and
  makes them public on start. Settings → Admin → Storage reads MinIO's metrics with the same
  credentials (nothing to set up; other S3 stores just show it as unavailable).
- nginx with TLS certificates (certbot), pm2, and rsync (`npm run build` publishes the web app
  with it).

### 2. Code and dependencies

```sh
git clone <repo> voicaw && cd voicaw
git checkout master
npm install
```

### 3. Server settings (`server/.env`)

The server refuses to start without the required settings. Never commit this file.

```sh
# JWT_SECRET
openssl rand -base64 48
# OPAQUE_SERVER_SETUP (never change it afterwards: every account's password stops working)
cd server && node --input-type=module -e "import o from '@serenity-kit/opaque'; await o.ready; console.log(o.server.createSetup())"
# VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (web push; changing them later drops every subscription)
npx web-push generate-vapid-keys
```

```ini
JWT_SECRET=...
OPAQUE_SERVER_SETUP=...
PORT=3002
NODE_ENV=production

VAPID_EMAIL=mailto:you@example.com
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...

S3_REGION=us-east-1
S3_ENDPOINT=https://media.voicaw.com
S3_ROOT_USER=...
S3_ROOT_PASSWORD=...

# Optional: longest message in characters (default 5000)
MAX_MESSAGE_LENGTH=5000
# Optional: database file (default server/voicaw.db; its -wal and -shm files go with it)
# DB_PATH=/path/to/voicaw.db

# Voice channels (step 5). Optional: without them voice channels can't be joined.
LIVEKIT_URL=wss://rtc.voicaw.com          # what browsers connect to
LIVEKIT_API_URL=http://127.0.0.1:7880     # how the API reaches LiveKit (default: LIVEKIT_URL over https)
LIVEKIT_API_KEY=voicaw
LIVEKIT_API_SECRET=...

# GIFs in the emoji picker (an API key from partner.klipy.com). Optional: without it there's
# no GIFs tab. A global admin can also set or replace it in Settings → Admin.
KLIPY_API_KEY=...

# Who can sign up: open (default), invite (only with an invite an admin made) or request (new
# accounts wait for an admin's approval). Optional; an admin can change it in Settings → Admin.
# SIGNUP_MODE=open

# Link previews in guilds: the server fetches links posted there (public addresses only).
# Optional, on by default; off here or in Settings → Admin.
# LINK_PREVIEWS=off

# The Android app's notifications (step 10): a Firebase service account's JSON key. Optional:
# without it the app only notifies while it's open.
# FCM_SERVICE_ACCOUNT=/path/to/fcm-service-account.json

# For a server other than voicaw.com's, which people pick on the login screen (Server → Change).
# Your own web app's address, if you serve one (comma-separated; app.voicaw.com and the desktop
# and Android apps are always allowed):
# ALLOWED_ORIGINS=https://chat.example.com
# The app's websocket, if it isn't /api/socket on the API's host (nginx must pass websocket
# upgrades under /api/ for that default):
# PUBLIC_WEBSOCKET_URL=wss://api.example.com
# Your terms of use and privacy policy (default voicaw.com's):
# TERMS_URL=https://example.com/terms/
# PRIVACY_URL=https://example.com/privacy/
```

The web origins the API accepts are listed in `server/config.js` (`allowedOrigins`), plus
`ALLOWED_ORIGINS`. voicaw.com's own server doesn't need any of the four above: its websocket
is the built-in one, and someone picking it on another build's login screen would also need
`PUBLIC_WEBSOCKET_URL=wss://api.voicaw.com` (app.voicaw.com's nginx doesn't pass websockets).

### 4. Client settings

`client/.env.production` (for `npm run build`) and `client/.env.development` (for `npm run dev`)
set where the client finds the API:

```ini
VITE_API_BASE_URL=https://app.voicaw.com/api/
VITE_WS_URL=wss://api.voicaw.com
```

Both files are git-ignored, so a fresh clone has neither. The API address ends in `/` (paths
are appended to it).

### 5. Voice (LiveKit)

Voice channels use a self-hosted [LiveKit](https://livekit.io) server, a single Go binary. It
forwards audio between the people in a channel without mixing or decoding it, so it needs very
little CPU. The host's upload bandwidth is the real limit (see below).

```sh
mkdir -p ~/livekit && cd ~/livekit
V=1.13.7   # latest: https://github.com/livekit/livekit/releases
curl -LO https://github.com/livekit/livekit/releases/download/v$V/livekit_${V}_linux_amd64.tar.gz
curl -L https://github.com/livekit/livekit/releases/download/v$V/checksums.txt | grep linux_amd64.tar.gz | sha256sum -c
tar xzf livekit_${V}_linux_amd64.tar.gz livekit-server && rm livekit_${V}_linux_amd64.tar.gz
openssl rand -base64 48 | tr -d '/+=\n'; echo   # the API secret: goes here and in server/.env
```

`~/livekit/livekit.yaml` (`chmod 600`, since it holds the secret):

```yaml
port: 7880                  # signalling (websocket), only reachable through nginx
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: 7881            # media over TCP, for networks that block UDP
  udp_port: 7882            # media over UDP, every call on this one port
  use_external_ip: true     # finds the public IP via STUN (the host is behind NAT)
  advertise_internal_ip: true  # lets clients on the same LAN connect directly
  interfaces:
    includes:
      - enp2s0              # the LAN interface (`ip -br addr`); skips Docker bridges
keys:
  voicaw: <API secret>
room:
  empty_timeout: 60
webhook:                    # tells the API who joins and leaves (it shows who's in each channel)
  api_key: voicaw
  urls:
    - http://127.0.0.1:3002/api/livekit/webhook
logging:
  level: info
turn:                       # TURN over TLS on 443, for networks that only allow the web
  enabled: true             # (section 7 shares 443 with nginx; leave the block out without it)
  domain: turn.voicaw.com   # a DNS name for this host, covered by a certificate nginx has
  tls_port: 7883            # plain TCP from nginx, which ends the TLS (only on 127.0.0.1 there)
  external_tls: true
  udp_port: 0               # no TURN over UDP
```

Without the `webhook:` block people can connect and talk, but nobody shows as being in the
channel. After changing the file, `pm2 restart voicaw-livekit`.

On start it logs `found external IP via STUN` with the public IP. `could not validate external
IP` means UDP 7882 isn't forwarded yet, or the router can't loop back to its own public IP.

LiveKit only looks the public IP up at startup. If the host's IP is dynamic (the ISP changes it
now and then), LiveKit keeps handing out the old one, and people outside the ISP's network get
"Could not connect to voice" until it restarts. `server/scripts/livekit-ip-watch.sh` restarts
it when the IP changes (two IP services must agree; it remembers the IP in
`~/livekit/public-ip`, and its first run restarts LiveKit once). Copy it next to LiveKit so it
doesn't depend on which branch the checkout is on, and run it from `crontab -e`:

```sh
cp server/scripts/livekit-ip-watch.sh ~/livekit/ip-watch.sh
```

```
*/5 * * * * /home/<you>/livekit/ip-watch.sh >> /home/<you>/livekit/ip-watch.log 2>&1
```

Optional, as root: LiveKit warns that the UDP receive buffer is small. That only matters with
many streams (video). To raise it:

```sh
echo 'net.core.rmem_max=5000000' > /etc/sysctl.d/90-livekit.conf && sysctl --system
```

Bandwidth: each voice stream is the channel's bitrate (64 kbit/s unless a guild changes it, up
to 384) about twice over, since LiveKit's packet loss protection (RED) sends every frame twice,
and the server sends everyone every other speaker, so the upload a channel needs grows with the
square of its size. For example, 10 people with everyone talking at 64 kbit/s come to about 90
streams, around 12 Mbit/s up. Silent listeners send almost nothing.

**More voice regions (optional).** Voice can go through more than one LiveKit server, like
Discord's regions: a server nearer some people (another host, another country), which a guild
picks per voice channel and an admin can make the default (see Voice regions in
`docs/voice-and-calls.md`). Set up LiveKit on that host as above, with its own API key and
secret (each server needs a different key), its own name (`rtc-de.example.com` behind nginx
there, or anything browsers reach over `wss://`), and its `webhook:` pointing at this API
from outside: `https://api.voicaw.com/api/livekit/webhook` (with that server's `api_key`).
Then add it in Settings → Admin → Voice regions: flag, name, its `wss://` address, the address
this API reaches it on if not the same over https, and the key and secret (stored in the
database; the panel never shows the secret again). Nothing to change in `server/.env`: the
LiveKit there is the built-in "Main" region.

### 6. Running (pm2)

```sh
pm2 start server/index.js --name voicaw-api --cwd server           # API on PORT
pm2 start ~/livekit/livekit-server --name voicaw-livekit --cwd ~/livekit -- --config livekit.yaml
pm2 save                     # so `pm2 resurrect` (and boot) brings them back
npm run build                # the web app, into /opt/voicaw-client (see Publishing in docs/client.md)
```

Never run `pm2 update` on a shared host (see `CLAUDE.md`).

Make yourself a global admin (Settings → Admin: app-wide settings such as the Klipy key, and
who else is an admin) once you've registered:

```sh
cd server && npm run admin -- <username>     # --remove takes it away
```

Back up the database every night (one copy, replaced each time; needs the `sqlite3` package; see
Backups in `docs/database.md`), with `crontab -e`:

```
30 3 * * * umask 077 && /usr/bin/sqlite3 /path/to/voicaw/server/voicaw.db ".timeout 30000" ".backup /path/to/backup/voicaw.db.tmp" && mv -f /path/to/backup/voicaw.db.tmp /path/to/backup/voicaw.db
```

### 7. nginx

One site per name, each with a certificate (`certbot --nginx -d <name>`):

| Name | Serves |
|---|---|
| `app.voicaw.com` | the web app: static files, `root /opt/voicaw-client`, `try_files $uri $uri/ /index.html`; `location /api/` → `http://localhost:3002` with `client_max_body_size 26M`; `/invite/<code>` sent to `/api/invite-embed/<code>` for link previewers (a `map` on the user agent: Discord, Slack... get the guild's Open Graph tags) (config: `website/nginx/app.voicaw.com`) |
| `voicaw.com` | the info and download site, `root /opt/voicaw-site`, its `/api/` like the app's, anything else redirected to app.voicaw.com (section 10; config: `website/nginx/voicaw.com`) |
| `api.voicaw.com` | `http://localhost:3002` (REST, the app's websocket and the bot gateway at `/api/gateway`: pass `Upgrade`/`Connection` on every path), `client_max_body_size 26M` |
| `media.voicaw.com` | the object store, `client_max_body_size 100M` (each request; bigger attachments come in parts, and MinIO's default `stale_uploads_expiry` of a day clears abandoned ones) |
| `rtc.voicaw.com` | LiveKit signalling, `http://127.0.0.1:7880` |

The API's `client_max_body_size 26M` is for webhooks and bots (Discord's API): a post can carry up
to 25 MB of files, and nginx's default of 1 MB would refuse most of them. Raising Settings →
Admin's Bot file size limit needs this raised to match (the limit plus 1 MB), on both sites.

Turn on compression in `/etc/nginx/nginx.conf`'s `http` block. Debian's default compresses only
HTML, which leaves the 1.7 MB main bundle, Strong noise suppression's 17 MB WebAssembly
(10 MB gzipped) and spellcheck's 550 KB dictionary to be downloaded whole:

```nginx
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types text/plain text/css application/json application/javascript text/javascript
           text/xml application/xml image/svg+xml application/wasm;
```

LiveKit's signalling is a long-lived websocket:

```nginx
server {
    listen 80;
    server_name rtc.voicaw.com;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Then `certbot --nginx -d rtc.voicaw.com` adds HTTPS. `curl https://rtc.voicaw.com` should answer
`OK`.

**TURN on 443** (for people on networks that block LiveKit's ports; see TURN in
`docs/voice-and-calls.md`). nginx's stream module takes port 443 and sends `turn.voicaw.com`
(by its TLS name) to LiveKit's TURN, everything else to the sites, which move to
`127.0.0.1:8443` with the PROXY protocol so they still see visitors' addresses. As root, once
LiveKit runs with its `turn:` block (section 5), with the certificate covering the TURN name:

```sh
sudo server/scripts/turn-443.sh turn.voicaw.com /etc/letsencrypt/live/voicaw.com 7883
```

It copies `/etc/nginx` to `/etc/nginx.bak-<time>` first, rewrites every enabled site's `listen
443 ssl` (IPv6 ones are dropped: the stream block listens on `[::]:443`), writes
`/etc/nginx/stream-443.conf` and `conf.d/proxy-protocol-real-ip.conf`, and puts the copy back
if `nginx -t` fails. Sites added later with `certbot --nginx` get `listen 443 ssl` again, which
can't share 443 with the stream block: run the script again after each one. To undo it, put the
backup back (`rm -rf /etc/nginx && cp -a /etc/nginx.bak-<time> /etc/nginx`, then `systemctl
reload nginx`). `openssl s_client -connect turn.voicaw.com:443 -servername turn.voicaw.com`
should then show the certificate, and `e2e/turn.mjs` checks the whole path on loopback.

### 8. Ports to open and forward to the host

| Port | Protocol | For |
|---|---|---|
| 80, 443 | TCP | nginx (every site, including LiveKit's signalling and, on 443, its TURN) |
| 7881 | TCP | LiveKit media over TCP (fallback when UDP is blocked) |
| 7882 | UDP | LiveKit media (voice) |

The media ports can't go through nginx. Forward them straight to the host, on the same port
numbers. People on networks that allow neither UDP 7882 nor TCP 7881 (some corporate and school
networks) get through TURN over TLS on 443 (section 7), which needs nothing more forwarded.

### 9. Desktop app (optional)

The desktop app (`electron/`) ships its own copy of the client and talks to the same API
(`voicaw://app` is already an allowed origin in `server/config.js`; the object store must allow
it too, which MinIO does by default). `npm run dist:electron` builds the installers for the
system it runs on; on Linux, the Windows one is built in Docker (electron-builder's image, with
wine); macOS ones need a Mac:

```bash
npm run dist:electron       # client build for the app (../build), then installers in dist-desktop/
npm run dist:electron:win   # the same, then the Windows installer, via Docker (electron/dist-win.sh)
```

The client build uses `client/.env.production`, unless there's a `client/.env.electron` with its
own `VITE_API_BASE_URL` / `VITE_WS_URL`.

Installed copies update themselves (`electron/updater.js`) from
`https://updates.voicaw.com/desktop/` (set `VOICAW_UPDATE_URL` when building to use another
address, or `VOICAW_AUTO_UPDATE=off` for a build that never looks unless asked: Settings →
Desktop App → Update automatically starts off). That's its own static site, with a download page at `https://updates.voicaw.com/`
(`updates/site/`) listing the newest installer for each system. Set it up once:

1. DNS: an `A` record for `updates.voicaw.com` pointing at the host.
2. The folder it serves, writable by the user who publishes:
   ```bash
   sudo mkdir -p /opt/voicaw-updates
   sudo chown "$USER":www-data /opt/voicaw-updates
   ```
3. nginx (the config is `updates/nginx/updates.voicaw.com`), then HTTPS:
   ```bash
   sudo cp updates/nginx/updates.voicaw.com /etc/nginx/sites-available/
   sudo ln -s /etc/nginx/sites-available/updates.voicaw.com /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d updates.voicaw.com
   ```

**Releases are built by GitHub** (`.github/workflows/desktop-release.yml`, on GitHub's own
machines, from the tagged commit), not on the host, and every file gets a Sigstore attestation
(which workflow built it, from which commit). The host only downloads, checks and publishes them.
It needs the GitHub CLI, logged in as someone who can push to the repository, once:

```bash
# GitHub's own package (Debian's gh is too old: `gh attestation` needs 2.49 or later)
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh
gh auth login
```

A release, desktop and Android together as one version X.Y.Z (they share version numbers), from
a commit that's on GitHub (usually `master`). Below, `X.Y.Z` is the new version and `R` is
`SADLADS/voicaw`.

1. **The version:** higher than what updates.voicaw.com has (`/opt/voicaw-updates/desktop/releases.json`
   and `android/releases.json`) and than every `desktop-v*` tag (`git ls-remote --tags origin
   'desktop-v*'`). Y and Z stay under 100 (Android's versionCode is X·10000 + Y·100 + Z).
2. **Tag it and push the tag**, which starts the workflow (Linux, Windows and Android; follow it
   on GitHub's Actions tab, or `gh run watch`):
   ```bash
   git tag -a desktop-vX.Y.Z -m "Desktop app X.Y.Z" && git push origin desktop-vX.Y.Z
   ```
3. **Download the GitHub Release** once it's built, and put the Windows installer's original
   name back: GitHub turns spaces into dots, but the update feeds name `Voicaw Setup X.Y.Z.exe`:
   ```bash
   gh release download desktop-vX.Y.Z --repo R --dir dist-release/X.Y.Z
   cd dist-release/X.Y.Z
   mv Voicaw.Setup.X.Y.Z.exe "Voicaw Setup X.Y.Z.exe"
   mv Voicaw.Setup.X.Y.Z.exe.blockmap "Voicaw Setup X.Y.Z.exe.blockmap"
   ```
4. **Check every file was built by the workflow, from that tag and commit, on GitHub's machines**
   (attestations go by content, so renamed files still check out). Publish nothing that fails:
   ```bash
   for f in *; do gh attestation verify "$f" --repo R \
     --signer-workflow R/.github/workflows/desktop-release.yml \
     --source-ref refs/tags/desktop-vX.Y.Z --source-digest "$(git rev-parse 'desktop-vX.Y.Z^{commit}')" \
     --deny-self-hosted-runners > /dev/null || echo "FAILED: $f"; done
   grep '^version' latest*.yml        # each says X.Y.Z
   mkdir android && mv *.apk *.aab android/ && cd ../..   # Android's files apart
   ```
5. **Publish the desktop app:** `node updates/publish.mjs dist-release/X.Y.Z` (it rebuilds
   voicaw.com's download links too), then check `https://updates.voicaw.com/desktop/latest-linux.yml`
   says X.Y.Z.
6. **Android**, the same version: section 10, "Releases built by GitHub".
7. **The web app:** `npm install && npm run build` (put live only if the build succeeds).
8. **The API**, in the live checkout: `git pull`, `npm install` if the lockfile changed, then
   `pm2 restart voicaw-api`, so the server runs the code the apps just got.

GitHub never gets a key to the host or the app. A failed build can be retried from the Actions
tab ("Re-run jobs"). Every step is safe to repeat, so one that failed (a Play upload, say) can
just be run again.

Building and publishing on the host still works (try-outs, or without GitHub): build, then
`node updates/publish.mjs` (`dist-desktop/` into `/opt/voicaw-updates`, or `<buildDir> <siteDir>`),
with `VOICAW_VERSION=X.Y.Z` stamping the version into the build.

`publish.mjs` copies the installers first and the `latest*.yml` feeds last (so an app never sees a
feed naming a file that isn't there yet), updates the page's list (`desktop/releases.json`), and
keeps older installers. Installers built on other machines (Windows, macOS) are published the
same way from their own folder: each run only replaces the systems it brings. The feeds and the
page are served uncached; installers (their names carry the version) are cached for good.

Linux AppImages, `.deb` packages and Windows installers update this way. macOS only updates a
signed app (an Apple developer account); unsigned, people download new versions by hand.

The Windows installer's look (`electron/installer/installer.nsh`) hangs off electron-builder's
NSIS template, so after upgrading electron-builder, try it under wine before releasing: run the
installer in the same Docker image with `WINEARCH=win64`, `DISPLAY` set to an Xvfb on the host
(mount `/tmp/.X11-unix`), and screenshot it with `import -window root`. It should show the
splash-like window, not a grey box, with "Installing update" when run with `--updated`. Wine's
process list makes the template's "Voicaw is running" check fire wrongly; a test build can skip it
with an `nsis.include` that does `!define VOICAW_SKIP_APP_CHECK` and then includes `installer.nsh`.

### 10. Android app (optional)

The Android app (`mobile/`, Capacitor) ships its own copy of the client like the desktop app
(`https://localhost` is already an allowed origin in `server/config.js`; the object store must
allow it too, which MinIO does by default). It builds in Docker, so the host needs nothing else:

```bash
npm run dist:android   # dist-android/voicaw-debug.apk (debug key, mobile/package.json's version)
```

The first run builds the `voicaw-android-build` image (JDK 21 and the Android SDK,
`mobile/Dockerfile`, a few GB) and Gradle's downloads (kept in `~/.gradle`). The client build uses
`client/.env.production`, unless there's a `client/.env.android`. Releases are built by GitHub
with the desktop app (below). A release built on the host instead, never changing tracked files
(the version is stamped into the build: `node updates/publish-android.mjs next patch` prints the
next one, higher than the one published; the first is `mobile/package.json`'s):

```bash
npm install
npm run build:android --workspace=client
(cd mobile && npx cap sync android)
VOICAW_VERSION=X.Y.Z sh mobile/dist-android.sh release   # dist-android/voicaw-X.Y.Z.apk and -play.aab
```

versionCode is X·10000 + Y·100 + Z, so Y and Z stay under 100. Each release is tagged
`android-vX.Y.Z` on the commit it was built from (`git tag -a android-vX.Y.Z <commit> -m
"Android app X.Y.Z" && git push origin android-vX.Y.Z`); desktop releases are tagged
`desktop-vX.Y.Z`.

**The release key**, made once (not once per machine):

```bash
mobile/make-release-key.sh   # ~/.voicaw-android-keys: voicaw-release.jks + its password, chmod 600
```

Back that folder up somewhere safe and copy it to any other machine that builds releases: every
APK must be signed with this key, or phones refuse it as an update, and a new key means everyone
uninstalls and installs again (logging in again). If the app goes on Google Play, choose this key
as its app signing key, so the website's APK and Play's update each other (it is: closed test,
2026-10-06).

**Publishing** (`node updates/publish-android.mjs publish dist-android/voicaw-X.Y.Z.apk X.Y.Z`) puts
`voicaw-<version>.apk`, `releases.json` and `voicaw.apk` (always the newest) in
`/opt/voicaw-updates/android/`. Since the app went to Google Play (2026-10-06) nothing offers
them: they're only for the copies already installed from there, which keep updating themselves.
voicaw.com sends people to Google Play's closed test instead (its form, docs/desktop-and-site.md
"Info site"). Apply
`updates/nginx/updates.voicaw.com`'s `/android/` locations to the live nginx once (APKs go out as
Android packages; `voicaw.apk` and `releases.json` aren't cached). Set `VOICAW_UPDATES_DIR` to
try it on another folder. The installed app looks at `releases.json` for new versions and, when
the person taps Update,
downloads the APK and asks Android to install it (Android asks once to allow installs from
Voicaw). `VOICAW_UPDATE_URL` at build time points a try-out build at another update folder.

**Releases built by GitHub.** Android isn't built here for a release: GitHub's release workflow
(section 9) builds the APK and the App Bundle unsigned (`mobile/dist-android.sh unsigned`, in the
same Docker image) and attests them. After section 9's step 4 (attestations checked, the files in
`dist-release/X.Y.Z/android/`), from the checkout:

```bash
# Sign both here: the key never goes to GitHub (into dist-android/)
mobile/sign-android.sh dist-release/X.Y.Z/android/voicaw-X.Y.Z-unsigned.apk \
  dist-release/X.Y.Z/android/voicaw-X.Y.Z-play-unsigned.aab X.Y.Z
node updates/publish-android.mjs publish dist-android/voicaw-X.Y.Z.apk X.Y.Z   # update site
gh release upload desktop-vX.Y.Z dist-android/voicaw-X.Y.Z.apk --repo SADLADS/voicaw --clobber
node updates/publish-play.mjs dist-android/voicaw-X.Y.Z-play.aab X.Y.Z         # Google Play
git tag -a android-vX.Y.Z "$(git rev-parse 'desktop-vX.Y.Z^{commit}')" -m "Android app X.Y.Z"
git push origin android-vX.Y.Z
```

The signed APK sits in the GitHub Release next to the unsigned one. Anyone can check it's
GitHub's build plus our signature and nothing else (with `pip install apksigcopier` and the
Android SDK's `apksigner`):

```bash
gh attestation verify voicaw-X.Y.Z-unsigned.apk --repo SADLADS/voicaw
apksigcopier compare voicaw-X.Y.Z.apk --unsigned voicaw-X.Y.Z-unsigned.apk   # no output: the same
apksigner verify --print-certs voicaw-X.Y.Z.apk                              # who signed it
```

The release key's certificate SHA-256 is
`5f7934c212fbb5667c26e2d5eec7c92eda269515d1eb80d25d414b08c62693ea`.

GitHub's build needs `google-services.json` (below) as a repository secret, set once:
`gh secret set GOOGLE_SERVICES_JSON --repo SADLADS/voicaw < mobile/android/app/google-services.json`
(again whenever the file changes).

**Google Play.** Every release also builds the same version as an App Bundle of the `play` flavour
(`dist-android/voicaw-<version>-play.aab`, signed with the release key), which never updates
itself (Play's rules forbid it) and lacks the permission to install packages. `updates/publish-play.mjs`
uploads it and releases it on Play's closed-testing track (`alpha`; new personal accounts need 12
testers for 14 days before production; `VOICAW_PLAY_TRACK=production` once out of it) through
the Google Play Developer API, once it has a key for it, set up once:

1. In the Google Cloud console (the Firebase project will do), enable the **Google Play Android
   Developer API**, then IAM & Admin → Service accounts → Create service account (no roles), and
   on it Keys → Add key → JSON. Save it as `~/.voicaw-android-keys/play-service-account.json`
   (`chmod 600`; or point `VOICAW_PLAY_KEY` at it) and back it up with the release key.
2. In the Play Console, Users and permissions → Invite new users: the service account's email,
   with access to Voicaw and the permission to release to testing tracks (and to production,
   later). Google can take a while (up to a day) before it's allowed. `node
   updates/publish-play.mjs check` logs in and lists the tracks without changing anything.

Without the key, upload the bundle from `dist-android/` by hand in the Play Console. Play needs each upload's version
higher than the last, so upload the bundle of each new release, never a rebuild of an old one. The first time, Play asks how the app is
signed: choose to **use your own key** ("Use a different app signing key" / "Export and upload a
key from Java keystore"), download the PEPK tool and encryption key it offers, and run the
command it shows with `--keystore=$HOME/.voicaw-android-keys/voicaw-release.jks --alias=voicaw`
(the password is in `~/.voicaw-android-keys/password`); then upload the zip it makes. Play then
signs with the same key as the website's APK, so either can update the other without losing
the app's storage. Play's own "let Google generate a key" would make the two apps different to
Android (people would have to uninstall one, and log in again, to switch).

Notifications while the app is closed, and calls ringing it, need Firebase Cloud Messaging
(Google's push service; without it the app only notifies while it's open, Settings → Android App
says so). Set it up once:

1. In the Firebase console (console.firebase.google.com), create a project (Analytics not
   needed), then add an Android app with the package name `com.voicaw.app`.
2. Download its `google-services.json` into `mobile/android/app/` (git-ignored) and rebuild the
   APK, and give GitHub's release build a copy (the `GOOGLE_SERVICES_JSON` secret, above).
3. Project settings → Service accounts → Generate new private key: save the JSON on the host
   where only the API's user can read it (e.g. `server/fcm-service-account.json`, `chmod 600`;
   it's git-ignored) and point the API at it in `server/.env`:
   ```
   FCM_SERVICE_ACCOUNT=/home/otto/git/voicaw/server/fcm-service-account.json
   ```
   then restart the API. A wrong file is reported at start and leaves the app without
   notifications.

Every push is encrypted for the phone it goes to (`server/fcm.js`), so Google relays only
ciphertext and learns when a phone gets something.

### 11. voicaw.com and app.voicaw.com

The web app lives at `app.voicaw.com`; `voicaw.com` is a small info and download site
(`website/`): what Voicaw is, a button for the newest desktop installer (the visitor's own system
when there's a build for it, else Windows) with its version, and every installer below. The
version and links are written into the page when it's built, from the update site's
`desktop/releases.json`, so it needs no script to show them. `updates/publish.mjs` rebuilds it
after every release (so `desktop-release/release.sh` keeps it current); to rebuild it by hand
(after editing `website/src/`):

```bash
npm run build:site        # into /opt/voicaw-site (or: node website/build.mjs <dir>, VOICAW_SITE_DIR)
```

voicaw.com keeps proxying `/api/` to the API for good (installed desktop apps, older builds and
webhook URLs people copied use `https://voicaw.com/api/`), and redirects every other path it
doesn't have (invite links, channel links) to the same path on app.voicaw.com. Browsers that
installed the app from voicaw.com get `website/src/service-worker.js` at the old service worker's
address: it removes the old app's caches and itself, so they stop being served the old app
(people then log in again at app.voicaw.com: keys and sessions are per address). A home screen
icon added before the move opens voicaw.com, which then says the app has moved.

Set it up once:

1. DNS: an `A` record for `app.voicaw.com` pointing at the host.
2. The site's folder, writable by the user who publishes releases, and a first build:
   ```bash
   sudo mkdir -p /opt/voicaw-site
   sudo chown "$USER":www-data /opt/voicaw-site
   npm run build:site
   ```
3. The app's site, then HTTPS for it:
   ```bash
   sudo cp website/nginx/app.voicaw.com /etc/nginx/sites-available/
   sudo ln -s /etc/nginx/sites-available/app.voicaw.com /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d app.voicaw.com
   ```
4. The client's API address in `client/.env.production` (section 4): with
   `VITE_API_BASE_URL=https://voicaw.com/api/`, change it to `https://app.voicaw.com/api/` (or
   `https://api.voicaw.com/api/`), then `npm run build`. Check the app at app.voicaw.com.
5. Switch voicaw.com over (it uses its existing certificate):
   ```bash
   sudo cp /etc/nginx/sites-available/voicaw.com ~/voicaw.com.nginx.bak
   sudo cp website/nginx/voicaw.com /etc/nginx/sites-available/voicaw.com
   sudo nginx -t && sudo systemctl reload nginx
   ```
   Copy it again whenever `website/nginx/voicaw.com` changes (the bot API docs at
   `/developers/docs/` and the bot gateway through `voicaw.com/api/` need its 2026-10-03 version).
