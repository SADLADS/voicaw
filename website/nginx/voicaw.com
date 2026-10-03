# voicaw.com: the info and download site (website/, built into /opt/voicaw-site by
# `npm run build:site` and after every desktop release). The app itself is at app.voicaw.com.
# Replaces the old voicaw.com site (which served the app); see README "voicaw.com and
# app.voicaw.com". Uses the certificate voicaw.com already has.
server {
    server_name voicaw.com;
    root /opt/voicaw-site;
    index index.html;

    add_header X-Content-Type-Options nosniff always;

    # The API stays here for good: installed desktop apps, older builds and webhook URLs people
    # copied (https://voicaw.com/api/webhooks/...) all use this address. Websockets too: a bot
    # pointed at https://voicaw.com/api gets its gateway here (wss://voicaw.com/api/gateway).
    location /api/ {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 26M;
    }

    # The build writes temporary files as .name before moving them into place.
    location ~ /\. { return 404; }

    # Replaces the old app's service worker in browsers that had it, then removes itself.
    location = /service-worker.js {
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
    }

    # The site's own files, and its folders' index.html (the bot API docs at /developers/docs/,
    # one folder per page); anything else was an app link (an invite, a channel, a DM, the
    # Developer Portal at /developers...), which lives at app.voicaw.com under the same path.
    # After changing this file, copy it to /etc/nginx/sites-available/voicaw.com and reload nginx
    # by hand (`sudo nginx -t && sudo systemctl reload nginx`): nothing deploys it.
    location = / {
        try_files /index.html =404;
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
    }
    location / {
        try_files $uri $uri/index.html @app;
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
    }
    location @app {
        return 301 https://app.voicaw.com$request_uri;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/voicaw.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/voicaw.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name voicaw.com;
    return 301 https://voicaw.com$request_uri;
}
