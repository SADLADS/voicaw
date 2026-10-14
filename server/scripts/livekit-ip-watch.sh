#!/bin/sh
# Restarts LiveKit when the host's public IPv4 address changes (README, "5. Voice (LiveKit)").
# LiveKit looks its public address up once, at startup (use_external_ip), and hands it to every
# browser; after the ISP changes the address, people outside its network can't connect to voice
# until LiveKit restarts. Run from cron every few minutes.
#
# Asks two services and acts only when both answer the same valid address, so one service
# failing or lying never restarts anything. The address LiveKit was last restarted for is kept
# in $STATE; with no file yet (the first run), LiveKit is restarted once to be sure.

PATH=/usr/local/bin:/usr/bin:/bin
STATE="${STATE:-$HOME/livekit/public-ip}"
APP="${APP:-voicaw-livekit}"

ask() { curl -4 -fsS -m 10 "$1" 2>/dev/null | tr -d '[:space:]'; }

a=$(ask https://api.ipify.org)
b=$(ask https://ipv4.icanhazip.com)
echo "$a" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || exit 0
[ "$a" = "$b" ] || exit 0

old=$(cat "$STATE" 2>/dev/null)
[ "$a" = "$old" ] && exit 0

echo "$(date '+%F %T') public IP ${old:-unknown} -> $a, restarting $APP"
pm2 restart "$APP" >/dev/null && echo "$a" > "$STATE"
