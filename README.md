# Cloudflare Agentic Doom

## stdout procotol

To show important messages coming from the game while it's running we send the following formatted stdout messages, which can be parsed in the web page running the wasm:

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
doom: 13, host disconnected
```

## Third-party Assets

### DOOM1.WAD

This project bundles `public/doom1.wad`, the shareware Doom IWAD from id Software.
See the Doom Wiki page for details: https://doomwiki.org/wiki/DOOM1.WAD

`DOOM1.WAD` is the shareware version of the original Doom IWAD. It contains the
first episode, "Knee-Deep in the Dead", and is © id Software / ZeniMax / Microsoft.
The shareware WAD is freely distributable for non-commercial use under the original
shareware terms. It is **not** released under the same license as this project's
source code (see `LICENSE`) and remains the property of its respective copyright
holders. Commercial redistribution is prohibited without permission from id Software.

The Doom source code itself was released by id Software under the GNU GPL in 1999,
but this license does **not** cover the WAD data files.

### Chocolate Doom

This project bundles `public/chocolate-doom.js` and `public/chocolate-doom.wasm`,
a WebAssembly build of the [Chocolate Doom](https://www.chocolate-doom.org/) engine.
Chocolate Doom is licensed under the GNU General Public License, version 2 or later
(GPL-2.0-or-later). See https://github.com/chocolate-doom/chocolate-doom for source
and license details.

