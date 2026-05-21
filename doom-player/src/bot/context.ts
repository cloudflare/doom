/**
 * BotContext: ergonomic, sandbox-friendly helper surface that user bot
 * code sees through codemode.
 *
 * Bot code never touches the raw WebMCP client. Instead it gets a
 * namespaced API (default `bot.*`) backed by this class:
 *
 *   - bot.getState()              snapshot of the engine state
 *   - bot.press(key, holdMs?)     press / hold a key
 *   - bot.sleep(ms)               cooperative delay
 *   - bot.log(...args)            forwarded to the host's log sink
 *                                 (typically the streaming HTTP response)
 *
 * It is the host's responsibility to drive the game to a "playing"
 * (or otherwise post-preroll) screen *before* handing the BotContext to
 * the runner. Bots assume the engine is already booted and the
 * `get_state` / `press_key` WebMCP tools are registered.
 *
 * Lower-level escape hatches like raw tool invocation or live tool
 * enumeration are intentionally *not* exposed: bots interact with the
 * game only through the curated surface above.
 */

import type { WebMCPClient } from "../cdp/webmcp";
import {
  McpEngineError,
  extractTextFromInvokeResult,
} from "../cdp/mcpPayload";

// ── Schema mirrored from player.ts / src/lib/doomState.ts ────────────
// (Kept independent so the bot surface is self-contained.)

export type BotScreenKind =
  | "title"
  | "menu"
  | "playing"
  | "demo"
  | "automap"
  | "intermission"
  | "dead"
  | "finale"
  | "unknown";

export type BotBearing = "far_left" | "left" | "center" | "right" | "far_right";
export type BotDistance = "near" | "mid" | "far" | "unknown";

export interface BotEnemySighting {
  type: string;
  bearing: BotBearing;
  distance: BotDistance;
}

export interface BotRaycast {
  bearing_deg: number;
  distance: number;
  hit: "wall" | "door" | "switch" | "exit" | "thing" | "open";
  thing_type?: string;
  thing_category?: string;
}

export interface BotThingSighting {
  type: string;
  category: string;
  bearing_deg: number;
  distance: number;
}

export interface BotPlayerPose {
  x: number;
  y: number;
  z: number;
  angle_deg: number;
  momx: number;
  momy: number;
}

export interface BotHud {
  health: number;
  armor: number;
  ammo: number;
  ammo_type: string;
  weapon: string;
  face_state: string;
  keys: string[];
}

export interface BotState {
  screen: BotScreenKind;
  hud: BotHud;
  player: BotPlayerPose | null;
  raycasts: BotRaycast[];
  things_visible: BotThingSighting[];
  enemies_visible: BotEnemySighting[];
  in_combat: boolean;
  low_health: boolean;
  caption: string;
}

/**
 * Keys understood by the doom page's `press_key` tool. This is not
 * enforced (the underlying tool accepts arbitrary strings) but it's
 * surfaced as a union so editor autocomplete can help bot authors.
 */
export type BotKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "fire"
  | "use"
  | "enter"
  | "escape"
  | "shift"
  | "space"
  | "tab"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "0"
  | (string & {}); // allow arbitrary strings without losing autocomplete

// ── BotContext ───────────────────────────────────────────────────────

export interface BotContextOptions {
  /**
   * Where `bot.log(...)` output is written. Typically a function that
   * pushes a line into the streaming HTTP response. Defaults to
   * `console.log`.
   */
  onLog?: (line: string) => void;
  /**
   * Optional clamp on `bot.sleep(ms)` so a runaway bot can't hog the
   * worker forever. Sleeps longer than this are capped. Defaults to
   * 5000ms.
   */
  maxSleepMs?: number;
}

/**
 * Host-side helper that bot code calls into. Each public async method
 * is exposed as a tool in the codemode sandbox.
 */
export class BotContext {
  #webmcp: WebMCPClient;
  #onLog: (line: string) => void;
  #maxSleepMs: number;
  // Diagnostics the host can read after the bot finishes.
  #stats = {
    stateReads: 0,
    keyPresses: 0,
    sleeps: 0,
    logs: 0,
    imageLogs: 0,
  };

  constructor(webmcp: WebMCPClient, opts: BotContextOptions = {}) {
    this.#webmcp = webmcp;
    this.#onLog = opts.onLog ?? ((line) => console.log(line));
    this.#maxSleepMs = opts.maxSleepMs ?? 5000;
  }

  /** Read the latest engine state. */
  async getState(): Promise<BotState> {
    this.#stats.stateReads += 1;
    const res = await this.#webmcp.invoke("get_state", {});
    if (res.status !== "Completed") {
      const detail =
        res.errorText ?? res.exception?.description ?? "(no detail)";
      throw new Error(`get_state failed: status=${res.status} ${detail}`);
    }
    let text: string | null;
    try {
      text = extractTextFromInvokeResult(res);
    } catch (err) {
      // McpEngineError carries the engine-side error string (e.g.
      // "Doom module not initialised yet"). Re-throw with a prefix
      // so the bot author can tell it came from the engine, not us.
      if (err instanceof McpEngineError) {
        throw new Error(`get_state engine error: ${err.message}`);
      }
      throw err;
    }
    if (text === null) {
      throw new Error(
        `get_state returned no text content. Raw output: ${safeStringify(res.output).slice(0, 200)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `get_state returned non-JSON text (${msg}). First 200 chars: ${text.slice(0, 200)}`,
      );
    }
    if (!isPlainState(parsed)) {
      const keys =
        parsed && typeof parsed === "object"
          ? Object.keys(parsed as Record<string, unknown>).join(",")
          : typeof parsed;
      throw new Error(
        `get_state returned unexpected JSON shape (keys=[${keys}])`,
      );
    }
    return parsed;
  }

  /**
   * Press (or hold) a key. `holdMs` defaults to a short tap that's
   * enough to register one game tic.
   */
  async press(key: BotKey, holdMs = 80): Promise<void> {
    this.#stats.keyPresses += 1;
    const res = await this.#webmcp.invoke("press_key", { key, holdMs });
    if (res.status !== "Completed") {
      throw new Error(
        `press_key(${key}, ${holdMs}ms) failed: status=${res.status} ${res.errorText ?? res.exception?.description ?? ""}`,
      );
    }
  }

  /** Cooperative delay. Capped at `maxSleepMs`. */
  async sleep(ms: number): Promise<void> {
    this.#stats.sleeps += 1;
    const clamped = Math.max(0, Math.min(this.#maxSleepMs, Math.floor(ms)));
    if (clamped === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, clamped));
  }

  /**
   * Append a line to the host log sink. Multiple args are joined with
   * spaces the same way `console.log` does.
   */
  async log(...args: unknown[]): Promise<void> {
    this.#stats.logs += 1;
    const line = args
      .map((v) => (typeof v === "string" ? v : safeStringify(v)))
      .join(" ");
    this.#onLog(line);
  }

  /**
   * Capture a pixel-perfect 320x200 PNG of the current frame, as
   * base64-encoded bytes plus mime type. Useful for piping into a
   * vision-capable LLM (see `ai.run(...)` in the sandbox).
   */
  async screenshot(): Promise<{ data: string; mimeType: string }> {
    const res = await this.#webmcp.invoke("get_screenshot", {});
    if (res.status !== "Completed") {
      throw new Error(
        `get_screenshot failed: status=${res.status} ${res.errorText ?? res.exception?.description ?? ""}`,
      );
    }
    // get_screenshot returns `{ content: [{ type: "image", data,
    // mimeType }, { type: "text", text }] }`. The MCP envelope can
    // be wrapped one extra layer by the CDP transport, mirroring
    // peelTextEnvelope in mcpPayload.ts; we walk at most a couple
    // of layers looking for the image item.
    let current: unknown = res.output;
    for (let depth = 0; depth < 4; depth++) {
      if (!current || typeof current !== "object") break;
      const content = (current as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const img = content.find(
          (c): c is { type: "image"; data: string; mimeType: string } =>
            !!c &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "image" &&
            typeof (c as { data?: unknown }).data === "string" &&
            typeof (c as { mimeType?: unknown }).mimeType === "string",
        );
        if (img) return { data: img.data, mimeType: img.mimeType };
        // Descend through a nested text-encoded envelope, if any.
        const text = content.find(
          (c): c is { type: "text"; text: string } =>
            !!c &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "text" &&
            typeof (c as { text?: unknown }).text === "string",
        );
        if (text) {
          try {
            current = JSON.parse(text.text);
            continue;
          } catch {
            break;
          }
        }
      }
      break;
    }
    throw new Error(
      `get_screenshot returned no image content. Raw: ${safeStringify(res.output).slice(0, 200)}`,
    );
  }

  /**
   * Stream an image to the host log pane. Only the most recent
   * image is kept by the UI -- this is a debug affordance, not a
   * gallery. Pass either the result of `bot.screenshot()` directly,
   * or any `{ data: base64, mimeType }` pair, plus an optional
   * caption.
   *
   * The image flows as a single sentinel-prefixed log line:
   *
   *   \u0001img:<json>
   *
   * The host React app peels the sentinel off and renders an <img>;
   * any other consumer of the stream just sees one weird line and
   * can ignore it.
   */
  async logImage(
    shot: { data: string; mimeType: string },
    caption?: string,
  ): Promise<void> {
    if (
      !shot ||
      typeof shot.data !== "string" ||
      typeof shot.mimeType !== "string"
    ) {
      throw new Error(
        "logImage: expected { data: base64-string, mimeType: string }",
      );
    }
    this.#stats.imageLogs += 1;
    // Hard cap so a bot can't blow up the streaming response. 512 KB
    // of base64 is ~384 KB of binary -- way more than any reasonable
    // debug screenshot at 320x200.
    if (shot.data.length > 512 * 1024) {
      throw new Error(
        `logImage: image too large (${shot.data.length} base64 chars; cap is 524288)`,
      );
    }
    // We only support PNG today (that's what get_screenshot returns).
    // The UI bounds the rendered size and preserves the real aspect
    // ratio via \`object-fit: contain\`, so any sensible dimensions are
    // fine — but reject pathologically large frames up front so a
    // typo'd bot can't push a 4K screenshot through the stream.
    if (shot.mimeType !== "image/png") {
      throw new Error(
        `logImage: expected mimeType "image/png", got "${shot.mimeType}"`,
      );
    }
    const dims = decodePngDimensions(shot.data);
    if (!dims) {
      throw new Error("logImage: payload is not a valid PNG (missing IHDR)");
    }
    const MAX_DIM = 2048;
    if (dims.width > MAX_DIM || dims.height > MAX_DIM) {
      throw new Error(
        `logImage: image too large (${dims.width}x${dims.height}; max dimension is ${MAX_DIM})`,
      );
    }
    const payload = JSON.stringify({
      mimeType: shot.mimeType,
      data: shot.data,
      caption: typeof caption === "string" ? caption : "",
    });
    this.#onLog(`\u0001img:${payload}`);
  }

  /**
   * Encode an RGBA pixel buffer into a base64-encoded PNG suitable
   * for handing straight to `logImage`. We do this host-side so bot
   * code can build memory / debug visualisations without dragging a
   * full PNG encoder into the sandbox.
   *
   * `rgba` must be exactly `width * height * 4` bytes (RGBA, 8 bits
   * per channel, top-to-bottom row order, no premultiplied alpha).
   * The encoder uses uncompressed deflate blocks — the file is a few
   * KB larger than a normal PNG but the code is simple and has zero
   * dependencies.
   */
  async encodePng(
    width: number,
    height: number,
    rgba: Uint8Array | number[],
  ): Promise<{ data: string; mimeType: string }> {
    return encodePngRgba(width, height, rgba);
  }

  /** Read-only snapshot of how the bot has used the context so far. */
  stats(): Readonly<{
    stateReads: number;
    keyPresses: number;
    sleeps: number;
    logs: number;
    imageLogs: number;
  }> {
    return { ...this.#stats };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Decode a PNG's IHDR width/height from its base64 payload. PNG layout:
 *   bytes  0..7   signature (89 50 4E 47 0D 0A 1A 0A)
 *   bytes  8..11  IHDR chunk length (always 13 for a valid PNG)
 *   bytes 12..15  "IHDR"
 *   bytes 16..19  width  (big-endian u32)
 *   bytes 20..23  height (big-endian u32)
 *
 * Returns null if the input doesn't look like a PNG. We only need the
 * first 24 bytes, so decoding the leading 32 base64 chars is enough.
 */
function decodePngDimensions(
  base64: string,
): { width: number; height: number } | null {
  if (base64.length < 32) return null;
  let head: string;
  try {
    head = atob(base64.slice(0, 32));
  } catch {
    return null;
  }
  if (head.length < 24) return null;
  // Signature check on the first 8 bytes (89 50 4E 47 0D 0A 1A 0A).
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (head.charCodeAt(i) !== sig[i]) return null;
  }
  const u32 = (off: number) =>
    (head.charCodeAt(off) << 24) |
    (head.charCodeAt(off + 1) << 16) |
    (head.charCodeAt(off + 2) << 8) |
    head.charCodeAt(off + 3);
  return { width: u32(16) >>> 0, height: u32(20) >>> 0 };
}

// ── PNG encoder ─────────────────────────────────────────────────────
//
// A small, dependency-free PNG encoder used by `BotContext.encodePng`.
// We emit a single IDAT chunk whose deflate stream is made entirely
// of uncompressed ("stored") blocks — that's the simplest legal
// deflate form: a 5-byte header per <= 65535-byte block, then raw
// bytes. Files are 0.5-1% larger than a properly-compressed PNG, but
// the encoder fits in ~60 lines and runs in any JS runtime (no
// CompressionStream / pako / canvas dependency).
//
// References:
//   PNG spec      https://www.w3.org/TR/png-3/
//   deflate spec  https://www.rfc-editor.org/rfc/rfc1951

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeU32BE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32BE(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  writeU32BE(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Walk the input in 8 KB chunks to avoid blowing the call-argument
  // limit of String.fromCharCode on large images.
  let bin = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(bin);
}

export function encodePngRgba(
  width: number,
  height: number,
  rgba: Uint8Array | number[],
): { data: string; mimeType: string } {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`encodePng: bad dimensions ${width}x${height}`);
  }
  const expected = width * height * 4;
  const src = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
  if (src.length !== expected) {
    throw new Error(
      `encodePng: expected ${expected} bytes for ${width}x${height} RGBA, got ${src.length}`,
    );
  }

  // Build the raw image stream with a filter byte (0 = None) per row.
  const rowStride = width * 4;
  const raw = new Uint8Array((rowStride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowStride + 1)] = 0;
    raw.set(src.subarray(y * rowStride, (y + 1) * rowStride), y * (rowStride + 1) + 1);
  }

  // zlib wrapper around uncompressed deflate blocks.
  const blocks: Uint8Array[] = [];
  const blockSize = 65535;
  for (let i = 0; i < raw.length; i += blockSize) {
    const len = Math.min(blockSize, raw.length - i);
    const last = i + len >= raw.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = last;
    header[1] = len & 0xff;
    header[2] = (len >>> 8) & 0xff;
    header[3] = ~len & 0xff;
    header[4] = (~len >>> 8) & 0xff;
    blocks.push(header);
    blocks.push(raw.subarray(i, i + len));
  }
  const adler = adler32(raw);
  let idatLen = 2 + 4; // zlib header + adler trailer
  for (const b of blocks) idatLen += b.length;
  const idat = new Uint8Array(idatLen);
  idat[0] = 0x78; // CM=8, CINFO=7
  idat[1] = 0x01; // FLEVEL=0, FCHECK chosen so (78*256 + 01) % 31 === 0
  let pos = 2;
  for (const b of blocks) {
    idat.set(b, pos);
    pos += b.length;
  }
  writeU32BE(idat, pos, adler);

  // IHDR.
  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = makeChunk("IHDR", ihdr);
  const idatChunk = makeChunk("IDAT", idat);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  const total =
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const png = new Uint8Array(total);
  let o = 0;
  png.set(sig, o); o += sig.length;
  png.set(ihdrChunk, o); o += ihdrChunk.length;
  png.set(idatChunk, o); o += idatChunk.length;
  png.set(iendChunk, o);

  return { data: bytesToBase64(png), mimeType: "image/png" };
}

function isPlainState(v: unknown): v is BotState {
  return (
    !!v &&
    typeof v === "object" &&
    "screen" in (v as Record<string, unknown>) &&
    "hud" in (v as Record<string, unknown>) &&
    "raycasts" in (v as Record<string, unknown>)
  );
}
