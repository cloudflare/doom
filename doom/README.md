# Wasm Doom

This is a [Chocolate Doom][1] **3.1.1** WebAssembly port with WebSockets
[support][4].

The codebase tracks upstream Chocolate Doom (currently 3.1.1) and adds a
custom `net_websockets` networking module so the engine can talk to a
WebSocket-based relay server (e.g. [doom-workers][8]) instead of the
standard SDL_net UDP transport.

## Requirements

You need Emscripten (EMSDK) and CMake.

Install the toolchain via Homebrew:

```
brew install emscripten cmake
```

…or use a manual EMSDK checkout. The `doom-build` target auto-detects an
EMSDK install at `~/emsdk` (or wherever `$EMSDK` points):

```
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install latest
~/emsdk/emsdk activate latest
brew install cmake
```

A native SDL2 install is **not** required for the wasm build — Emscripten
ships and links its own SDL2 / SDL2_mixer ports.

## Compiling

From the repository root:

```
make doom-clean
make doom-build
```

The `doom-build` target invokes `emcmake cmake` followed by `cmake --build`,
then copies `chocolate-doom.{html,js,wasm,wasm.map}` from `build/src/`
into `./src/` next to `index.html`.

## Running

Copy the shareware version of [doom1.wad][3] to [./src][9] (make sure it
has the name `doom1.wad`).

Then:

```
cd src
python3 -m http.server 8000
```

Then open your browser and point it to http://0.0.0.0:8000/

Doom should start (local mode, no network). Check [doom-workers][8] if
you want to run multiplayer locally.

Inspect [src/index.html][6] for startup details.

Check our live multiplayer [demo][5] and [blog post][7].

## What's new in 3.1.1

This port now tracks upstream Chocolate Doom 3.1.1, which brings:

- Native Emscripten build target support (auto-detected via the toolchain).
- OPL music deadlock fix when running under Emscripten.
- Many gameplay, IWAD detection, save-load, mouse and renderer fixes.
- Doom 1.5 support, MP3 music packs, smooth pixel scaling option, and
  support for non-US backslash key.
- Pet-name based default user names for privacy.

See `NEWS.md` upstream for the full list:
<https://github.com/chocolate-doom/chocolate-doom/blob/master/NEWS.md>

## stdout protocol

To show important messages coming from the game while it's running we
emit the following formatted stdout messages, which can be parsed in the
web page running the wasm:

```
doom: 1, failed to connect to websockets server
doom: 2, connected to %s
doom: 3, we're out of client addresses
doom: 4, ws error(eventType=%d, userData=%d)
doom: 5, ws close(eventType=%d, wasClean=%d, code=%d, reason=%s, userData=%d)
doom: 6, failed to send ws packet, reconnecting
doom: 7, failed to connect to %s
doom: 8, uid is %d
doom: 9, disconnected from server
doom: 10, game started
doom: 11, entering fullscreen
doom: 12, client '%s' timed out and disconnected
```

## License

Chocolate Doom and this port are distributed under the GNU GPL. See the
COPYING file for more information.

[1]: https://github.com/chocolate-doom/chocolate-doom
[2]: https://emscripten.org/
[3]: https://doomwiki.org/wiki/DOOM1.WAD
[4]: src/net_websockets.c
[5]: https://silentspacemarine.com
[6]: src/index.html
[7]: https://blog.cloudflare.com/doom-multiplayer-workers
[8]: https://github.com/cloudflare/doom-workers
[9]: src
