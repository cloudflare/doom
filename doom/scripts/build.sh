#!/bin/bash
# Doom-wasm build script.
#
# Drives a CMake-based Emscripten build of Chocolate Doom 3.1.1 with the
# WebSocket networking module and copies the resulting browser artifacts
# (chocolate-doom.{html,js,wasm,wasm.map}) into ./src/ where index.html
# expects to find them.
set -e

cd "$(dirname "$0")/.."

# Activate EMSDK if emcc isn't already in PATH. We always export the
# EMSDK_* environment variables so that subprocesses spawned by `make`
# (i.e. each emcc invocation) see the bundled Python and Node.
if ! command -v emcc >/dev/null 2>&1; then
    EMSDK_DIR="${EMSDK:-$HOME/emsdk}"
    if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
        # shellcheck disable=SC1091
        source "$EMSDK_DIR/emsdk_env.sh"
    else
        echo "error: emcc not found and $EMSDK_DIR/emsdk_env.sh missing." >&2
        echo "Install EMSDK to ~/emsdk or set \$EMSDK, or 'brew install emscripten'." >&2
        exit 1
    fi
fi

# emsdk_env.sh sets these but doesn't always export them; the emcc shell
# launcher reads $EMSDK_PYTHON before falling back to /usr/bin/python3,
# which on macOS is too old to satisfy emscripten 5.x.
export EMSDK EMSDK_NODE EMSDK_PYTHON

if ! command -v emcmake >/dev/null 2>&1; then
    echo "error: emcmake not found in PATH (after emsdk activation)." >&2
    exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
    echo "error: cmake not found in PATH." >&2
    echo "Install with 'brew install cmake' or your distro package manager." >&2
    exit 1
fi

BUILD_DIR="${BUILD_DIR:-build}"

# Configure (only re-runs cmake if the cache is stale).
emcmake cmake -S . -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_SDL2_NET=OFF \
    -DENABLE_SDL2_MIXER=ON

# Build.
cmake --build "$BUILD_DIR" -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

# Copy outputs into src/ so they sit next to index.html / doom1.wad /
# default.cfg, which is what the index.html script tag (and the
# Module.preRun preload) expects.
for ext in html js wasm wasm.map; do
    artifact="$BUILD_DIR/src/chocolate-doom.$ext"
    if [ -f "$artifact" ]; then
        cp "$artifact" "src/chocolate-doom.$ext"
    fi
done

echo
echo "Build complete. Artifacts in src/:"
ls -lh src/chocolate-doom.* 2>/dev/null || true
