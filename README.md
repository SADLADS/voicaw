# voicaw

A Discord-style chat app: end-to-end encrypted direct messages, and guilds (Discord-style servers) with
text and voice channels. See `CLAUDE.md` for how it works and how to develop on it.

## Initial setup

How a fresh host is set up, in order. The live host is set up like this: the API and the test
site run from a checkout of `dev` under pm2, voicaw.com is a static build in
`/opt/voicaw-client`, and nginx handles TLS for all of them.

### 1. Requirements

- Node 24 LTS and npm 11.
- An S3-compatible object store (e.g. MinIO) for uploads, profile pictures, guild icons and
  emoji. The server creates its buckets (`uploads`, `profile-pics`, `guild-icons`, `emojis`) and
  makes them public on start.
- nginx with TLS certificates (certbot), and pm2.
- On hosts with glibc older than 2.38 (Debian 12): gcc, make and python3, to compile `sqlite3`
  (next step).

### 2. Code and dependencies

```sh
git clone <repo> voicaw && cd voicaw
git checkout dev
# Only on glibc < 2.38 (check with `ldd --version`): sqlite3's prebuilt binary won't load.
echo 'build_from_source=sqlite3' > .npmrc
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
# Optional: database file (default server/voicaw.db)
# DB_PATH=/path/to/voicaw.db

# Voice channels (step 5). Optional: without them voice channels can't be joined.
LIVEKIT_URL=wss://rtc.voicaw.com          # what browsers connect to
LIVEKIT_API_URL=http://127.0.0.1:7880     # how the API reaches LiveKit (default: LIVEKIT_URL over https)
LIVEKIT_API_KEY=voicaw
LIVEKIT_API_SECRET=...

# GIFs in the emoji picker (an API key from partner.klipy.com). Optional: without it there's
# no GIFs tab. A global admin can also set or replace it in Settings → Admin.
KLIPY_API_KEY=...
```

The web origins the API accepts are listed in `server/config.js` (`allowedOrigins`). Change
them for other domains.

### 4. Client settings

`client/.env.production` (for `npm run build`) and `client/.env.development` (for `npm run dev`)
set where the client finds the API:

```ini
VITE_API_BASE_URL=https://api.voicaw.com
VITE_WS_URL=wss://api.voicaw.com
```

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
```

Without the `webhook:` block people can connect and talk, but nobody shows as being in the
channel. After changing the file, `pm2 restart voicaw-livekit`.

On start it logs `found external IP via STUN` with the public IP. `could not validate external
IP` means UDP 7882 isn't forwarded yet, or the router can't loop back to its own public IP.

Optional, as root: LiveKit warns that the UDP receive buffer is small. That only matters with
many streams (video). To raise it:

```sh
echo 'net.core.rmem_max=5000000' > /etc/sysctl.d/90-livekit.conf && sysctl --system
```

Bandwidth: each voice stream is about 30–50 kbit/s, and the server sends everyone every other
speaker, so the upload a channel needs grows with the square of its size. For example, 10
people with everyone talking come to about 90 streams, around 4 Mbit/s up. Silent listeners
send almost nothing.

### 6. Running (pm2)

```sh
pm2 start server/index.js --name voicaw-api --cwd server           # API on PORT
pm2 start npm --name voicaw-test -- run dev                         # test site, vite dev on :5173
pm2 start ~/livekit/livekit-server --name voicaw-livekit --cwd ~/livekit -- --config livekit.yaml
pm2 save                     # so `pm2 resurrect` (and boot) brings them back
npm run build                # the static site, into /opt/voicaw-client
```

Never run `pm2 update` on a shared host (see `CLAUDE.md`).

Make yourself a global admin (Settings → Admin: app-wide settings such as the Klipy key, and
who else is an admin) once you've registered:

```sh
cd server && npm run admin -- <username>     # --remove takes it away
```

### 7. nginx

One site per name, each with a certificate (`certbot --nginx -d <name>`):

| Name | Serves |
|---|---|
| `voicaw.com` | static files, `root /opt/voicaw-client`, `try_files $uri $uri/ /index.html` |
| `test.voicaw.com` | `http://localhost:5173` (vite dev, with websockets for hot reload) |
| `api.voicaw.com` | `http://localhost:3002` (REST and the websocket) |
| `media.voicaw.com` | the object store, `client_max_body_size 100M` |
| `rtc.voicaw.com` | LiveKit signalling, `http://127.0.0.1:7880` |

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

### 8. Ports to open and forward to the host

| Port | Protocol | For |
|---|---|---|
| 80, 443 | TCP | nginx (every site, including LiveKit's signalling) |
| 7881 | TCP | LiveKit media over TCP (fallback when UDP is blocked) |
| 7882 | UDP | LiveKit media (voice) |

The media ports can't go through nginx. Forward them straight to the host, on the same port
numbers. There's no TURN server yet, so people on networks that allow neither UDP 7882 nor TCP
7881 (some corporate and school networks) can't join voice until one is added. That would be
TURN over TLS on 443, which needs its own IP or an nginx `stream` SNI split.
