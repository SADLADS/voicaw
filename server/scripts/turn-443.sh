#!/bin/bash
# Puts LiveKit's TURN (over TLS) on port 443 beside nginx's sites, for networks that only
# allow web traffic (no UDP 7882, no TCP 7881). nginx's stream module takes 443 and reads
# each connection's TLS name (SNI) without decrypting it: the TURN name goes to a TLS end
# that passes plain TCP to LiveKit (turn.external_tls), everything else to the sites, which
# move to 127.0.0.1:8443 and get the visitor's address from a PROXY protocol header.
#
#   sudo server/scripts/turn-443.sh turn.voicaw.com /etc/letsencrypt/live/voicaw.com 7883
#
# Run it again after adding a site with certbot --nginx (certbot writes `listen 443 ssl`,
# which can't share 443 with the stream block). /etc/nginx is copied first and put back if
# nginx -t fails. See TURN in docs/voice-and-calls.md and README.md section 7.
set -euo pipefail

domain=${1:?usage: turn-443.sh <turn domain> <certificate directory> <LiveKit TURN port>}
certs=${2:?certificate directory, holding fullchain.pem and privkey.pem}
turn_port=${3:?LiveKit turn.tls_port}
[ "$(id -u)" = 0 ] || { echo 'Run as root (sudo).' >&2; exit 1; }
[ -r "$certs/fullchain.pem" ] && [ -r "$certs/privkey.pem" ] || { echo "No certificate in $certs." >&2; exit 1; }

backup=/etc/nginx.bak-$(date +%Y%m%d-%H%M%S)
cp -a /etc/nginx "$backup"
restore() {
  echo "Putting /etc/nginx back from $backup." >&2
  rm -rf /etc/nginx && cp -a "$backup" /etc/nginx
  nginx -t && systemctl reload nginx
  exit 1
}

# Every enabled site's 443: IPv4 moves behind the split, IPv6 goes (the stream block takes
# [::]:443 too). Commented lines are left alone.
for site in /etc/nginx/sites-enabled/*; do
  file=$(readlink -f "$site")
  v4=$(grep -cE '^\s*listen\s+443\s+ssl' "$file" || true)
  v6=$(grep -cE '^\s*listen\s+\[::\]:443\s+ssl' "$file" || true)
  if [ "$v6" -gt "$v4" ]; then
    echo "$file listens on [::]:443 without 443; fix it by hand." >&2
    restore
  fi
  sed -i -E \
    -e 's/^(\s*)listen\s+443\s+ssl(\s+http2)?\s*;/\1listen 127.0.0.1:8443 ssl\2 proxy_protocol;/' \
    -e 's/^(\s*)listen\s+\[::\]:443\s+ssl(\s+http2)?\s*;/\1# listen [::]:443 ssl\2; # 443 is the stream block'"'"'s (turn-443.sh)/' \
    "$file"
done
if grep -lE '^\s*listen\s+(\S*:)?443\b' $(readlink -f /etc/nginx/sites-enabled/*) 2>/dev/null; then
  echo 'The sites above still listen on 443 in a form this script does not know.' >&2
  restore
fi

# The sites' $remote_addr from the PROXY header (only connections from the stream block are trusted).
cat > /etc/nginx/conf.d/proxy-protocol-real-ip.conf <<'EOF'
# Written by voicaw's server/scripts/turn-443.sh: HTTPS reaches the sites through the stream
# block on 443 (/etc/nginx/stream-443.conf), which sends the visitor's address first.
set_real_ip_from 127.0.0.1;
real_ip_header proxy_protocol;
EOF

cat > /etc/nginx/stream-443.conf <<EOF
# Written by voicaw's server/scripts/turn-443.sh. Port 443: $domain (by its TLS name) is
# LiveKit's TURN, everything else nginx's sites on 127.0.0.1:8443.
stream {
    map \$ssl_preread_server_name \$tls_443_backend {
        $domain 127.0.0.1:8444;
        default 127.0.0.1:8443;
    }

    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;
        proxy_pass \$tls_443_backend;
        proxy_protocol on;
        proxy_timeout 1d;            # websockets: the sites' own timeouts still apply
    }

    # TURN's TLS ends here; LiveKit gets plain TCP (turn.external_tls: true).
    server {
        listen 127.0.0.1:8444 ssl proxy_protocol;
        ssl_certificate $certs/fullchain.pem;
        ssl_certificate_key $certs/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        proxy_pass 127.0.0.1:$turn_port;
        proxy_timeout 1h;            # a call's TURN connection always has traffic (ICE checks)
    }
}
EOF
grep -q '^include /etc/nginx/stream-443.conf;' /etc/nginx/nginx.conf ||
  printf '\ninclude /etc/nginx/stream-443.conf;\n' >> /etc/nginx/nginx.conf

nginx -t || restore
systemctl reload nginx
sleep 1
ss -tlnp | grep -qE '127\.0\.0\.1:8443\b' || { echo 'nginx did not move the sites to 8443.' >&2; restore; }
echo "Done. Backup: $backup (rm -rf it once everything works)."
