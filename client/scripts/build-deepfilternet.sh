#!/bin/sh
# Builds DeepFilterNet's WebAssembly (the "Strong" noise suppression, src/voice/noise/) from
# its source at a fixed commit, with the DeepFilterNet3 model compiled in, into
# src/voice/noise/deepfilter/. The output is committed, so this only needs running to update
# it. Needs git, Rust with the wasm32-unknown-unknown target, wasm-pack and patch; takes
# about 10 minutes.
set -eu

COMMIT=d375b2d8309e0935d165700c91da9de862a99c31 # DeepFilterNet main, 2024-10-17
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../src/voice/noise/deepfilter"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet https://github.com/Rikorose/DeepFilterNet.git "$WORK/DeepFilterNet"
cd "$WORK/DeepFilterNet"
git checkout --quiet "$COMMIT"
patch -p1 < "$HERE/deepfilternet-wasm.patch"

# SIMD makes the model several times faster; every browser with AudioWorklet has it.
RUSTFLAGS="-C target-feature=+simd128" wasm-pack build libDF --release --target web --features wasm

mkdir -p "$OUT"
cp libDF/pkg/df_bg.wasm libDF/pkg/df.js LICENSE-MIT LICENSE-APACHE "$OUT/"
echo "Built into $OUT"
