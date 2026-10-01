# updates.voicaw.com: the desktop app's update feed and download page (see README "Desktop app").
# A plain static site, separate from voicaw.com: /opt/voicaw-updates, filled by
# `node updates/publish.mjs`. Install it as /etc/nginx/sites-available/updates.voicaw.com, link
# it into sites-enabled, then `sudo certbot --nginx -d updates.voicaw.com` adds HTTPS (and the
# redirect from http) like the other sites.
server {
    listen 80;
    server_name updates.voicaw.com;

    root /opt/voicaw-updates;
    index index.html;
    autoindex off;

    add_header X-Content-Type-Options nosniff always;

    # The publish script writes temporary files as .name before moving them into place.
    location ~ /\. { return 404; }

    location / {
        try_files $uri $uri/ =404;
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
    }

    # What the installed app asks for on every check (latest.yml, latest-linux.yml,
    # latest-mac.yml) and what the download page reads: never cached, so a release shows at once.
    location ~ ^/desktop/[^/]+\.(yml|json)$ {
        types { text/yaml yml; application/json json; }
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
    }

    # Installers, update zips and blockmaps. Their names carry the version, so they never change.
    # Served as downloads (never shown or run by the browser); range requests (the updater's
    # differential downloads, resumed downloads) work as nginx serves them.
    location /desktop/ {
        types { }
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff always;
    }
}
