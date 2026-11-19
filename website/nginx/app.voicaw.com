# app.voicaw.com: the web app (the client build in /opt/voicaw-client, `npm run build`), which used
# to be voicaw.com. Install it as /etc/nginx/sites-available/app.voicaw.com, link it into
# sites-enabled, then `sudo certbot --nginx -d app.voicaw.com` adds HTTPS (and the redirect from
# http). See README "voicaw.com and app.voicaw.com".

# Link previewers (Discord, Slack...) don't run the app, so on /invite/<code> they get the API's
# page with the guild's Open Graph tags instead (GET /api/invite-embed/:code, docs/guilds.md).
map $http_user_agent $voicaw_link_previewer {
    default 0;
    "~*(discordbot|slackbot|twitterbot|facebookexternalhit|telegrambot|whatsapp|linkedinbot|mastodon|skypeuripreview|redditbot|embedly)" 1;
}

server {
    listen 80;
    server_name app.voicaw.com;
    root /opt/voicaw-client;
    index index.html;

    # Security headers (security audit, 2026-11-18). nginx drops the server's add_header lines in
    # any location with its own, so each such location repeats them. HSTS: browsers only ever
    # come here over https once they've been once. frame-ancestors / X-Frame-Options: no other
    # site can frame the app (an OAuth consent or bot invite is one click). No referrer: the
    # app's addresses (guild and channel ids) never reach other sites; YouTube's players, which
    # need one, ask for the origin on their own iframes. The page's own Content-Security-Policy
    # (a <meta> from client/vite.config.js, scripts only) can't say frame-ancestors, so that's
    # here; both apply. Restricting more (styles, pictures, connections) is to come on its own.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options DENY always;
    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    # index.html (every app route falls back to it) is always asked again, so a new build is
    # picked up at once; its scripts and styles are under /assets/, named by their content.
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Frame-Options DENY always;
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
    }

    location ~ ^/invite/(?<voicaw_invite>[^/]+)$ {
        if ($voicaw_link_previewer) {
            rewrite ^ /api/invite-embed/$voicaw_invite last;
        }
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 26M;
    }

    location = /service-worker.js {
        add_header Cache-Control "no-cache";
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Frame-Options DENY always;
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
    }
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Frame-Options DENY always;
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
    }
    location /emoji/ {
        add_header Cache-Control "public, max-age=2592000";
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Frame-Options DENY always;
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
    }
}
