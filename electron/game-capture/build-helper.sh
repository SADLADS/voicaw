#!/bin/sh
# Cross-compiles voicaw-capture.exe (Game capture in docs/desktop-and-site.md) on Linux, into
# electron/game-capture/dist/, with MinGW-w64 in Docker (Dockerfile.mingw, built once as
# voicaw-mingw). `npm run dist:electron:win` runs it; releases build it with MSVC instead
# (helper/CMakeLists.txt). Statically linked: no runtime DLLs beside it.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/dist"
if ! docker image inspect voicaw-mingw >/dev/null 2>&1; then
    docker build -t voicaw-mingw -f "$here/Dockerfile.mingw" "$here"
fi
exec docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$here":/src \
    -w /src \
    voicaw-mingw \
    x86_64-w64-mingw32-g++-posix -std=c++17 -O2 -Wall -Wextra -municode \
        -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 \
        -static -static-libgcc -static-libstdc++ \
        -o dist/voicaw-capture.exe helper/voicaw-capture.cpp \
        -ld3d11 -ldxgi -lwinmm -lshell32 -luser32
