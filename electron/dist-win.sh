#!/bin/sh
# Builds the Windows installer on Linux (`npm run dist:electron:win` from the repo root, after the
# client build): electron-builder in its Docker image with wine, which NSIS needs. Runs as you, so
# dist-desktop/ isn't left owned by root; Electron and NSIS downloads are kept in ~/.cache. The
# installer isn't code-signed (Windows SmartScreen warns on first run). The image is pinned by
# digest, not its moving tag (updating it: `docker buildx imagetools inspect
# electronuserland/builder:wine`, then edit the digest here).
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
exec docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/home \
    -e ELECTRON_CACHE=/cache/electron \
    -e ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    -v "$root":/project \
    -v "$HOME/.cache/electron":/cache/electron \
    -v "$HOME/.cache/electron-builder":/cache/electron-builder \
    -w /project/electron \
    electronuserland/builder:wine@sha256:41ae540902461b6cbc988987db79547fcc10cda04d2a6c6367504f59d4b37c64 \
    sh -c 'mkdir -p "$HOME" && npx electron-builder --win --config builder.config.js'
