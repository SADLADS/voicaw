#!/bin/sh
# Builds the Windows installer on Linux (`npm run dist:electron:win` from the repo root, after the
# client build): electron-builder in its Docker image with wine, which NSIS needs. Runs as you, so
# dist-desktop/ isn't left owned by root; Electron and NSIS downloads are kept in ~/.cache. The
# installer isn't code-signed (Windows SmartScreen warns on first run).
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
    electronuserland/builder:wine \
    sh -c 'mkdir -p "$HOME" && npx electron-builder --win --config builder.config.js'
