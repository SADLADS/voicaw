# media.voicaw.com: Voicaw's object store (Garage). Garage has no bucket policies, so public
# reads go to its website endpoint (each bucket has website access on) and everything signed
# or writing goes to its S3 API. Addresses stay https://media.voicaw.com/<bucket>/<key>, as
# messages (encrypted ones too) hold them and can never be rewritten.

# A request is signed if it has an Authorization header or is a pre-signed URL.
map $http_authorization $media_signed_header { "" 0; default 1; }
map $args $media_signed_query { "~*(^|&)X-Amz-Signature=" 1; default 0; }
map $request_method $media_is_read { GET 1; HEAD 1; default 0; }
map "$media_is_read$media_signed_header$media_signed_query" $media_use_web { "100" 1; default 0; }

# /<bucket>/<key>, taken from the raw request so the key is passed on exactly as sent.
map $request_uri $media_bucket { "~^/(?<b>[^/?]+)/" $b; default ""; }
map $request_uri $media_key { "~^/[^/?]+(?<k>/[^?]*)" $k; default "/"; }
# Only the app's own buckets (server/bucketSetup.js BUCKETS) are readable without a signature:
# any other bucket given website access on Garage (a backup, a test) stays private here.
map $media_bucket $media_public_bucket { "~^(uploads|profile-pics|guild-icons|emojis|sounds)$" 1; default 0; }

server {
    server_name media.voicaw.com;

    # HTTPS arrives through stream-443.conf's split (README 7, TURN on 443), with the PROXY protocol.
    listen 127.0.0.1:8443 ssl proxy_protocol;
    ssl_certificate /etc/letsencrypt/live/voicaw.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/voicaw.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Each request is at most 100MB (bigger attachments come in parts, see Big files in docs/uploads.md).
    client_max_body_size 100M;

    location / {
        if ($media_use_web) { rewrite ^ /__garage_web last; }
        proxy_pass http://127.0.0.1:3900;
        # Signatures cover the Host header: it must reach Garage as the client sent it.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_http_version 1.1;
    }

    location = /__garage_web {
        internal;
        if ($media_public_bucket = 0) { return 404; }
        proxy_pass http://127.0.0.1:3902$media_key$is_args$args;
        # Public reads are files, never pages (security audit, 2026-11-18): no guessing a type
        # from the bytes, and anything opened as a document runs no script and loads nothing.
        add_header X-Content-Type-Options nosniff always;
        add_header Content-Security-Policy "sandbox; default-src 'none'" always;
        proxy_set_header Host $media_bucket.web.garage.internal;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name media.voicaw.com;
    return 301 https://$host$request_uri;
}
