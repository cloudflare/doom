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

  /** Read-only snapshot of how the bot has used the context so far. */
  stats(): Readonly<{
    stateReads: number;
    keyPresses: number;
    sleeps: number;
    logs: number;
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

function isPlainState(v: unknown): v is BotState {
  return (
    !!v &&
    typeof v === "object" &&
    "screen" in (v as Record<string, unknown>) &&
    "hud" in (v as Record<string, unknown>) &&
    "raycasts" in (v as Record<string, unknown>)
  );
}
