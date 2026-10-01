# app.voicaw.com: the web app (the client build in /opt/voicaw-client, `npm run build`), which used
# to be voicaw.com. Install it as /etc/nginx/sites-available/app.voicaw.com, link it into
# sites-enabled, then `sudo certbot --nginx -d app.voicaw.com` adds HTTPS (and the redirect from
# http). See README "voicaw.com and app.voicaw.com".
server {
    listen 80;
    server_name app.voicaw.com;
    root /opt/voicaw-client;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 26M;
    }

    location = /service-worker.js { add_header Cache-Control "no-cache"; }
    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    location /emoji/  { add_header Cache-Control "public, max-age=2592000"; }
}
