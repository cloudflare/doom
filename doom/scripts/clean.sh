#!/bin/bash
# Remove all CMake build artifacts and the in-tree browser bundle.
set -e

cd "$(dirname "$0")/.."

rm -rf build
rm -f src/chocolate-doom.html \
      src/chocolate-doom.js \
      src/chocolate-doom.wasm \
      src/chocolate-doom.wasm.map \
      src/websockets-doom.html \
      src/websockets-doom.js \
      src/websockets-doom.wasm \
      src/websockets-doom.wasm.map
