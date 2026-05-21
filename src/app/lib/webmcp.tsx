// WebMCP tool registrations for the Doom UI.
//
// Two registration patterns coexist:
//
//   * Screen-component hooks (useHomeTool, useChooseIwadTool,
//     useTypeOfGameTool). Mounted by the matching React screen and
//     unmounted when that screen navigates away — so the tool is only
//     visible during that pre-game step. No engine state inspection
//     required, the React tree already knows which screen is up.
//
//   * In-game tool components (<PressKeyTool/>, <GetMenuTool/>, …).
//     One component per WebMCP tool, each calling useWebMCP exactly
//     once. The aggregator <InGameTools/> polls the engine's
//     screen-kind via wmcp_get_state_json() and renders only the
//     components whose gating predicate matches the current state.
//     When a component is unmounted its useWebMCP cleanup fires and
//     navigator.modelContext deregisters the tool, so the agent's
//     tool list always reflects what's actually doable on screen.
//
// `initWebMCP()` should be called once at app boot before any component
// renders. It installs the WebMCP polyfill so `navigator.modelContext` is
// available in browsers that don't yet ship the standard natively.

import { useEffect, useRef, useState } from "react";
import { initializeWebMCPPolyfill } from "@mcp-b/webmcp-polyfill";
import { useWebMCP } from "usewebmcp";
import { IWADS } from "../../lib/common";
import {
  EMPTY_DOOM_VISION_STATE,
  type DoomVisionState,
  type ScreenKind,
} from "../../lib/doomState";

export const initWebMCP = () => {
  initializeWebMCPPolyfill();
};

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = {
  isError?: boolean;
  content: ContentItem[];
};

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const errorResult = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

// Hoisted to module scope so its identity is stable across renders.
// usewebmcp re-registers a tool whenever any of its config references
// change (see deps array in useWebMCP's effect). An inline
// `{ type: "object", properties: {} }` in every render is a fresh
// object identity each time, which under React 19 Strict Mode races
// with the polyfill's `registerTool` check and throws "Duplicate tool
// name". Reusing this constant for every empty-input tool keeps the
// effect inert across renders.
const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

// ---------------------------------------------------------------------------
// Home screen: pick solo vs multiplayer
// ---------------------------------------------------------------------------

const HOME_INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["solo", "multiplayer"],
      description: "Which game mode to start.",
    },
  },
  required: ["mode"],
} as const;

export const useHomeTool = (onSubmit: (multiplayer: boolean) => void) => {
  useWebMCP({
    name: "start_game",
    description:
      "Start a new Doom game from the home screen. Choose 'solo' for single-player or 'multiplayer' to host a multiplayer room. Advances to the IWAD picker.",
    inputSchema: HOME_INPUT_SCHEMA,
    execute: async (args) => {
      const mode = args?.mode;
      if (mode !== "solo" && mode !== "multiplayer") {
        return errorResult(
          `Invalid mode "${mode}". Must be "solo" or "multiplayer".`,
        );
      }
      onSubmit(mode === "multiplayer");
      return textResult(
        `Started ${mode} game. Now on the IWAD selection screen.`,
      );
    },
  });
};

// ---------------------------------------------------------------------------
// IWAD picker: choose which Doom data file to load
// ---------------------------------------------------------------------------

const IWAD_KEYS = Object.keys(IWADS);
const IWAD_DESCRIPTION = IWAD_KEYS.map((k) => `${k} (${IWADS[k].label})`).join(
  ", ",
);

const CHOOSE_IWAD_INPUT_SCHEMA = {
  type: "object",
  properties: {
    iwad: {
      type: "string",
      enum: IWAD_KEYS,
      description: `Which IWAD (game data file) to load. Available: ${IWAD_DESCRIPTION}.`,
    },
  },
  required: ["iwad"],
} as const;

export const useChooseIwadTool = (onSubmit: (iwad: string) => void) => {
  useWebMCP({
    name: "choose_iwad",
    description: `Select which IWAD (Doom game data) to play. Call this after start_game. Valid values: ${IWAD_DESCRIPTION}.`,
    inputSchema: CHOOSE_IWAD_INPUT_SCHEMA,
    execute: async (args) => {
      const iwad = args?.iwad;
      if (!iwad || !(iwad in IWADS)) {
        return errorResult(
          `Unknown IWAD "${iwad}". Valid values: ${IWAD_KEYS.join(", ")}.`,
        );
      }
      onSubmit(iwad);
      return textResult(`Selected IWAD "${IWADS[iwad].label}".`);
    },
  });
};

// ---------------------------------------------------------------------------
// Multiplayer type picker: deathmatch vs cooperative
// ---------------------------------------------------------------------------

const TYPE_OF_GAME_INPUT_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["deathmatch", "cooperative"],
      description:
        "Multiplayer game type. 'deathmatch' is free-for-all PvP; 'cooperative' is co-op against monsters.",
    },
  },
  required: ["type"],
} as const;

export const useTypeOfGameTool = (onSubmit: (type: string) => void) => {
  useWebMCP({
    name: "choose_game_type",
    description:
      "Choose the multiplayer game type. Use 'deathmatch' for free-for-all PvP or 'cooperative' for co-op.",
    inputSchema: TYPE_OF_GAME_INPUT_SCHEMA,
    execute: async (args) => {
      const type = args?.type;
      if (type !== "deathmatch" && type !== "cooperative") {
        return errorResult(
          `Invalid game type "${type}". Must be "deathmatch" or "cooperative".`,
        );
      }
      onSubmit(type);
      return textResult(`Selected ${type} mode.`);
    },
  });
};

// ---------------------------------------------------------------------------
// In-game tools (active while chocolate-doom WASM is running).
//
// We can't call into the WASM directly (chocolate-doom doesn't expose any
// EMSCRIPTEN_KEEPALIVE'd symbols), so the strategy is:
//
//   * Input — synthesize KeyboardEvent on `window`. SDL2's emscripten port
//     registers its keydown/keyup listener on EMSCRIPTEN_EVENT_TARGET_WINDOW,
//     so a synthetic event with `code` + `key` set is indistinguishable from
//     a real keypress (same trick VirtualJoysticks.tsx already uses).
//
//   * State readback — `get_screenshot` returns the canvas as a PNG data URL.
//     Vision-capable models can read ammo / health / armor / arms / face
//     status directly off the HUD. A future improvement is to extend the
//     WASM build with `EMSCRIPTEN_KEEPALIVE` functions like wmcp_get_health()
//     that read from players[consoleplayer], which would let us return
//     structured JSON instead.
// ---------------------------------------------------------------------------

// Doom key bindings (default.cfg / m_controls.c). The `code` field is what
// SDL maps to a scancode; `key` is the produced character.
type DoomKey = { code: string; key: string };

const KEY: Record<string, DoomKey> = {
  // Movement / aim
  up: { code: "ArrowUp", key: "ArrowUp" },
  down: { code: "ArrowDown", key: "ArrowDown" },
  left: { code: "ArrowLeft", key: "ArrowLeft" },
  right: { code: "ArrowRight", key: "ArrowRight" },
  forward: { code: "KeyW", key: "w" },
  backward: { code: "KeyS", key: "s" },
  strafeLeft: { code: "KeyA", key: "a" },
  strafeRight: { code: "KeyD", key: "d" },
  // Action
  fire: { code: "Space", key: " " },
  use: { code: "KeyE", key: "e" },
  speed: { code: "ShiftLeft", key: "Shift" },
  // Menu
  enter: { code: "Enter", key: "Enter" },
  escape: { code: "Escape", key: "Escape" },
  backspace: { code: "Backspace", key: "Backspace" },
  yes: { code: "KeyY", key: "y" },
  no: { code: "KeyN", key: "n" },
  // Function keys
  f2: { code: "F2", key: "F2" }, // save
  f3: { code: "F3", key: "F3" }, // load
  f6: { code: "F6", key: "F6" }, // quicksave
  f9: { code: "F9", key: "F9" }, // quickload
  // Game
  tab: { code: "Tab", key: "Tab" }, // automap
  pause: { code: "Pause", key: "Pause" },
  say: { code: "KeyT", key: "t" },
  // Weapons 1-7
  "1": { code: "Digit1", key: "1" },
  "2": { code: "Digit2", key: "2" },
  "3": { code: "Digit3", key: "3" },
  "4": { code: "Digit4", key: "4" },
  "5": { code: "Digit5", key: "5" },
  "6": { code: "Digit6", key: "6" },
  "7": { code: "Digit7", key: "7" },
};

const KEY_ALIAS_LIST = Object.keys(KEY);

// Dispatch a single keypress (keydown then keyup) on `window`. Returns null
// on success, or an error message string if the key alias is unknown.
const pressKey = async (alias: string, holdMs = 50): Promise<string | null> => {
  const k = KEY[alias];
  if (!k) {
    return `Unknown key "${alias}".`;
  }
  const down = new KeyboardEvent("keydown", {
    code: k.code,
    key: k.key,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(down);
  await new Promise((r) => setTimeout(r, holdMs));
  const up = new KeyboardEvent("keyup", {
    code: k.code,
    key: k.key,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(up);
  return null;
};

// Type a string by dispatching one key event per character. Only printable
// ASCII is supported (Doom's chat input is similarly limited).
const typeText = async (text: string, perCharMs = 40): Promise<void> => {
  for (const ch of text) {
    const code = (() => {
      if (/[a-z]/.test(ch)) return `Key${ch.toUpperCase()}`;
      if (/[A-Z]/.test(ch)) return `Key${ch}`;
      if (/[0-9]/.test(ch)) return `Digit${ch}`;
      if (ch === " ") return "Space";
      return "";
    })();
    const ev = (type: "keydown" | "keyup") =>
      new KeyboardEvent(type, {
        code,
        key: ch,
        bubbles: true,
        cancelable: true,
      });
    window.dispatchEvent(ev("keydown"));
    await new Promise((r) => setTimeout(r, perCharMs / 2));
    window.dispatchEvent(ev("keyup"));
    await new Promise((r) => setTimeout(r, perCharMs / 2));
  }
};

// --- press_key -------------------------------------------------------------

const PRESS_KEY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    key: {
      type: "string",
      enum: KEY_ALIAS_LIST,
      description:
        "Which key to press. Movement: up/down/left/right, forward/backward/strafeLeft/strafeRight. Action: fire, use, speed. Menu: enter, escape, backspace, yes, no. Game: tab (map), pause, say. Weapons: 1-7. Function: f2, f3, f6 (quicksave), f9 (quickload).",
    },
    holdMs: {
      type: "number",
      description:
        "How long to hold the key down in milliseconds before releasing. Default 50ms; use a few hundred for movement.",
    },
  },
  required: ["key"],
} as const;

const useInGamePressKeyTool = () => {
  useWebMCP({
    name: "press_key",
    description:
      "Press and release a single key in the running Doom game. Use for menu navigation, firing, switching weapons, opening the automap, etc.",
    inputSchema: PRESS_KEY_INPUT_SCHEMA,
    execute: async (args) => {
      const alias = String(args?.key ?? "");
      const holdMs = typeof args?.holdMs === "number" ? args.holdMs : 50;
      const err = await pressKey(alias, holdMs);
      if (err) return errorResult(err);
      return textResult(`Pressed "${alias}".`);
    },
  });
};

// --- start_new_game --------------------------------------------------------

const useStartNewGameTool = () => {
  useWebMCP({
    name: "start_new_game",
    description:
      "Open the main menu (Esc) and confirm 'New Game' (Enter). Works from the title screen AND from attract-mode demo playback (screen='demo') — in both cases the default menu selection is 'New Game'. Lands you on the skill-level picker. From there call get_menu to see the skill items, then press_key('down') / press_key('up') to highlight the desired skill and press_key('enter') to confirm. Nightmare skill triggers a confirmation prompt — answer with press_key('yes').",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      await pressKey("escape");
      await new Promise((r) => setTimeout(r, 200));
      // The default menu selection is "New Game", so just confirm.
      await pressKey("enter");
      await new Promise((r) => setTimeout(r, 200));
      return textResult(
        "Opened New Game menu. Skill picker should be on screen — call get_menu to see the items, then press_key arrow/enter to pick one.",
      );
    },
  });
};

// --- pause / quicksave / quickload / toggle_automap / switch_weapon -------
//
// Each shortcut is its own hook so the orchestrator below can decide
// independently when each one is appropriate (e.g. switch_weapon only
// during gameplay, pause during gameplay or automap, quickload almost
// anywhere). Schemas are module-level constants — see the inline-schema
// warning at the top of usewebmcp's docs.

const SWITCH_WEAPON_INPUT_SCHEMA = {
  type: "object",
  properties: {
    slot: {
      type: "number",
      enum: [1, 2, 3, 4, 5, 6, 7],
      description:
        "Weapon slot: 1=fist/chainsaw, 2=pistol, 3=shotgun/SSG, 4=chaingun, 5=rocket launcher, 6=plasma rifle, 7=BFG9000.",
    },
  },
  required: ["slot"],
} as const;

const usePauseTool = () => {
  useWebMCP({
    name: "pause",
    description: "Pause or unpause the running game (toggles Pause key).",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      await pressKey("pause");
      return textResult("Toggled pause.");
    },
  });
};

const useQuicksaveTool = () => {
  useWebMCP({
    name: "quicksave",
    description: "Quicksave the current game (F6).",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      await pressKey("f6");
      // Quicksave prompts for a slot the first time. Confirm with Enter.
      await new Promise((r) => setTimeout(r, 200));
      await pressKey("enter");
      return textResult("Quicksave triggered.");
    },
  });
};

const useQuickloadTool = () => {
  useWebMCP({
    name: "quickload",
    description: "Quickload the last quicksave (F9). Confirms the prompt.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      await pressKey("f9");
      await new Promise((r) => setTimeout(r, 200));
      await pressKey("yes");
      return textResult("Quickload triggered.");
    },
  });
};

const useToggleAutomapTool = () => {
  useWebMCP({
    name: "toggle_automap",
    description: "Toggle the in-game automap (Tab).",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      await pressKey("tab");
      return textResult("Toggled automap.");
    },
  });
};

const useSwitchWeaponTool = () => {
  useWebMCP({
    name: "switch_weapon",
    description: "Switch to a weapon slot 1-7.",
    inputSchema: SWITCH_WEAPON_INPUT_SCHEMA,
    execute: async (args) => {
      const slot = Number(args?.slot);
      if (![1, 2, 3, 4, 5, 6, 7].includes(slot)) {
        return errorResult(`Invalid weapon slot ${args?.slot}. Must be 1-7.`);
      }
      await pressKey(String(slot));
      return textResult(`Switched to weapon slot ${slot}.`);
    },
  });
};

// --- say (chat) ------------------------------------------------------------

const SAY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description:
        "Chat message to send. ASCII letters, digits and spaces only.",
    },
  },
  required: ["message"],
} as const;

const useSayTool = () => {
  useWebMCP({
    name: "say",
    description:
      "Open the in-game chat (T), type the message and send it. Multiplayer only.",
    inputSchema: SAY_INPUT_SCHEMA,
    execute: async (args) => {
      const message = String(args?.message ?? "").trim();
      if (!message) return errorResult("Empty chat message.");
      if (!/^[A-Za-z0-9 ]+$/.test(message)) {
        return errorResult(
          `Message contains unsupported characters. Use ASCII letters, digits and spaces only.`,
        );
      }
      await pressKey("say");
      await new Promise((r) => setTimeout(r, 200));
      await typeText(message);
      await new Promise((r) => setTimeout(r, 100));
      await pressKey("enter");
      return textResult(`Sent chat message: "${message}".`);
    },
  });
};

// --- get_state -------------------------------------------------------------
//
// Engine-side state read. Calls into the chocolate-doom wasm module via
// the exported wmcp_get_state_json() function (see doom/src/doom/wmcp_state.c)
// and returns a parsed DoomVisionState JSON object.
//
// This is the agent's primary perception primitive. It is 100% accurate
// because it reads the same C globals the renderer reads — there is no
// inference involved. get_screenshot still exists for vision-based
// experiments and for callers that want to see the actual frame.
//
// Failure modes the tool handles:
//   * Module not loaded yet — returns an error result, the agent should
//     retry after waiting a beat.
//   * ccall returned a non-string (Emscripten yields 0 for null) — falls
//     back to EMPTY_DOOM_VISION_STATE and reports the failure.
//   * JSON.parse failed — same fallback; this would be a bug in
//     wmcp_state.c.

const useGetStateTool = () => {
  useWebMCP({
    name: "get_state",
    description:
      "Read the current Doom game state directly from the engine. Returns structured JSON: screen kind (title/menu/playing/demo/automap/intermission/dead/finale), HUD (health, armor, ammo, weapon, face, keys), player pose (x/y/z map units, angle_deg in [0,360), momx/momy per-tic velocity), 8 raycasts evenly spread across the forward 90-degree FOV (each with bearing_deg in [-45,+45] using screen convention where + = right of facing, distance in map units, hit kind wall/door/switch/exit/thing/open, plus inline thing_type/thing_category when hit='thing'), things_visible array of all pickups/decor/blockers crossed by any ray (deduped, each with type+category like 'green_armor'/armor, 'stimpack'/health, 'shotgun'/weapon, 'clip'/ammo, 'blue_keycard'/key, 'exploding_barrel'/barrel, 'decoration'/decor, plus enemies), enemies in the FOV (with bearing and distance bins), and high-level booleans (in_combat, low_health). Use player.momx/momy after a movement input to detect 'wedged' states (both zero = blocked). Use raycasts to navigate without screenshots: small distance with hit='wall' means turn; hit='door' near distance ~64 means press use; hit='open' with large distance means clear corridor; check things_visible for pickups to grab and barrels to shoot. This is accurate and instant — prefer it over get_screenshot for state-driven decisions. Note: screen='demo' means Doom is playing back a built-in attract-mode demo and ignoring input — the agent should call start_new_game or press_key('escape') to break out, not try to play.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      const mod = window.Module;
      if (!mod || !mod.ccall) {
        return errorResult(
          "Doom module not initialised yet (ccall unavailable). Try again shortly.",
        );
      }
      try {
        const raw = mod.ccall(
          "wmcp_get_state_json",
          "string",
          [],
          [],
        );
        if (typeof raw !== "string" || raw.length === 0) {
          return errorResult(
            "wmcp_get_state_json returned an empty/non-string result.",
          );
        }
        let parsed: DoomVisionState;
        try {
          parsed = JSON.parse(raw) as DoomVisionState;
        } catch (err) {
          return errorResult(
            `wmcp_get_state_json returned invalid JSON: ${err instanceof Error ? err.message : String(err)}. Raw: ${raw.slice(0, 200)}`,
          );
        }
        // Defensive merge: if the C side ever omits a field (e.g. a
        // schema update lands engine-side before this TS file catches
        // up), the agent still gets a complete object.
        const merged: DoomVisionState = {
          ...EMPTY_DOOM_VISION_STATE,
          ...parsed,
          hud: { ...EMPTY_DOOM_VISION_STATE.hud, ...(parsed.hud ?? {}) },
          // player is nullable; preserve null when the engine reports it
          // (e.g. on title / menu / intermission screens), otherwise
          // accept the parsed object as-is. Fall back to null on schema
          // skew rather than fabricating a fake pose.
          player:
            parsed.player === null || parsed.player === undefined
              ? null
              : parsed.player,
          raycasts: Array.isArray(parsed.raycasts) ? parsed.raycasts : [],
          things_visible: Array.isArray(parsed.things_visible)
            ? parsed.things_visible
            : [],
          enemies_visible: Array.isArray(parsed.enemies_visible)
            ? parsed.enemies_visible
            : [],
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(merged),
            },
          ],
        };
      } catch (err) {
        return errorResult(
          `Failed to read engine state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
};

// --- get_menu --------------------------------------------------------------
//
// Returns a structured description of the active Doom menu: items with
// resolved human-readable labels, the cursor position, enabled state,
// and the optional alphaKey hot-key for each item. Pulls from the C
// helper wmcp_get_menu_json (see doom/src/doom/wmcp_state.c).
//
// Notes:
//   * Doom doesn't keep menu labels as strings — the menuitem_t.name
//     field is a 9-char graphic lump name like "M_NGAME". The C side
//     translates known lump names to readable labels via a hand-built
//     table. Unknown items pass the raw lump name through.
//   * The load/save menus are special-cased: their labels come from
//     savegamestrings[i] (the user-typed save names) rather than from
//     a lump table.
//   * Returns { menu: null } when no menu is open, so the agent can
//     call this safely without first checking get_state.

type DoomMenuItem = {
  index: number;
  label: string;
  enabled: boolean;
  cursor: boolean;
  hot_key: string;
};

type DoomMenuState = {
  cursor_index: number;
  is_save_menu: boolean;
  is_load_menu: boolean;
  items: DoomMenuItem[];
  error?: string;
};

const useGetMenuTool = () => {
  useWebMCP({
    name: "get_menu",
    description:
      [
        "Read the currently displayed Doom menu directly from the engine.",
        "Returns { menu: { cursor_index, is_save_menu, is_load_menu, items: [{ index, label, enabled, cursor, hot_key }] } }, or { menu: null } when no menu is open.",
        "Labels are human-readable: known M_XXXXX graphic lump names are translated (e.g. M_NGAME -> 'New Game'); unknown ones pass through. Save/load menus return the user-typed slot names.",
        "",
        "To act on a menu, call this to see the items, then drive the cursor with press_key:",
        "  - cursor_index tells you which item is currently highlighted (0-based).",
        "  - To reach a target item, call press_key('down') (or 'up') exactly |target.index - cursor_index| times. Each keypress moves one item; Doom auto-skips disabled items.",
        "  - Then call press_key('enter') to activate the highlighted item.",
        "  - press_key('escape') backs out one menu level.",
        "  - Some items have a hot_key letter (e.g. 'n' for 'New Game'); pressing that key moves the cursor to that item but does NOT activate it — you still need 'enter'.",
        "",
        "Items with enabled=false won't activate even if you press Enter on them (e.g. unsaved slots on the load menu).",
      ].join(" \n"),
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      const mod = window.Module;
      if (!mod || !mod.ccall) {
        return errorResult(
          "Doom module not initialised yet (ccall unavailable).",
        );
      }
      try {
        const raw = mod.ccall("wmcp_get_menu_json", "string", [], []);
        if (typeof raw !== "string" || raw.length === 0) {
          return errorResult(
            "wmcp_get_menu_json returned an empty/non-string result.",
          );
        }
        const parsed = JSON.parse(raw) as DoomMenuState | null;
        if (parsed === null) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ menu: null }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ menu: parsed }),
            },
          ],
        };
      } catch (err) {
        return errorResult(
          `Failed to read menu state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
};

// --- get_screenshot --------------------------------------------------------
//
// Returns a pixel-perfect 320x200 PNG of the current frame.
//
// The bytes come from the wasm directly: wmcp_get_framebuffer_rgba (see
// doom/src/doom/wmcp_state.c) returns a pointer into the linear memory
// to a static 320x200 RGBA buffer it just populated from I_VideoBuffer
// using the current gamma-corrected palette. We read those bytes via
// Module.HEAPU8, hand them to a 2D canvas as ImageData, and let the
// browser's built-in encoder produce the PNG.
//
// Pulling straight from I_VideoBuffer (instead of grabbing the styled
// DOM canvas and resampling it) gives the agent exactly what Doom drew,
// with no SDL-texture -> WebGL -> CSS-scale resampling in between.
//
// If the wasm isn't initialised yet (boot, WAD download) or the engine's
// framebuffer pointer is still NULL we return an error rather than
// falling back to the DOM canvas — by design.
//
// Constants here mirror SCREENWIDTH/SCREENHEIGHT in i_video.h. Keep in
// sync if Doom ever switches resolutions.

const FB_WIDTH = 320;
const FB_HEIGHT = 200;
const FB_BYTES = FB_WIDTH * FB_HEIGHT * 4;

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      resolve(result.replace(/^data:image\/png;base64,/, ""));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });

const encodePngFromRgba = async (rgba: Uint8ClampedArray): Promise<string> => {
  const off = document.createElement("canvas");
  off.width = FB_WIDTH;
  off.height = FB_HEIGHT;
  const ctx = off.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D context for PNG encode.");
  // Construct ImageData via createImageData rather than `new ImageData(...)`
  // to side-step a TS 5+ strictness around Uint8ClampedArray<ArrayBufferLike>
  // vs <ArrayBuffer> in the constructor signature. Same effect at runtime.
  const imgData = ctx.createImageData(FB_WIDTH, FB_HEIGHT);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  const blob: Blob = await new Promise((resolve, reject) => {
    off.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    );
  });
  return blobToBase64(blob);
};

const useScreenshotTool = () => {
  useWebMCP({
    name: "get_screenshot",
    description:
      "Capture the current frame at Doom's native 320x200 resolution as a PNG. Pixel-perfect: the bytes are read directly from the engine's framebuffer with the current gamma-corrected palette applied. Returns an image content block — use this to read the HUD (ammo, health, armor, weapons, face) and to see what's on screen.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    execute: async () => {
      const mod = window.Module;
      const fbFn = mod?._wmcp_get_framebuffer_rgba;
      const heap = mod?.HEAPU8;
      if (typeof fbFn !== "function" || !(heap instanceof Uint8Array)) {
        return errorResult(
          "Doom wasm not initialised yet (framebuffer export unavailable). Try again shortly.",
        );
      }
      let ptr: number;
      try {
        ptr = fbFn();
      } catch (err) {
        return errorResult(
          `wmcp_get_framebuffer_rgba threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!ptr || ptr <= 0) {
        return errorResult(
          "wmcp_get_framebuffer_rgba returned a null pointer (engine framebuffer not ready).",
        );
      }
      try {
        // Defensive copy: the C side reuses the static buffer on the next
        // call and ImageData wants stable ownership of the bytes. Slicing
        // here also detaches us from any future heap growth.
        const rgba = new Uint8ClampedArray(FB_BYTES);
        rgba.set(heap.subarray(ptr, ptr + FB_BYTES));
        const base64 = await encodePngFromRgba(rgba);
        return {
          content: [
            { type: "image", data: base64, mimeType: "image/png" },
            {
              type: "text",
              text: `Screenshot captured (320x200 PNG, pixel-perfect from engine framebuffer).`,
            },
          ],
        };
      } catch (err) {
        return errorResult(
          `Failed to encode framebuffer PNG: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
};

// ---------------------------------------------------------------------------
// Screen-kind polling + in-game tool orchestrator
//
// Why a poll: wmcp_get_state_json() reads C globals (gamestate,
// menuactive, automapactive, players[].playerstate). There's no event
// the engine fires when those flip — we'd have to patch chocolate-doom
// to add one. A 250ms poll is plenty for tool-availability decisions
// (humans can't open a menu and act in less than that). If profiling
// ever shows this on the hot path, we can drop the cadence further or
// hook the engine's menu/automap toggles.
// ---------------------------------------------------------------------------

const SCREEN_KIND_POLL_MS = 250;

/**
 * Polls the engine's screen-kind label and returns the current value.
 * Returns "unknown" until the wasm is initialised. Only re-renders the
 * caller when the kind actually changes (cheap string equality on a
 * ref-cached previous value).
 */
const useDoomScreenKind = (): ScreenKind => {
  const [kind, setKind] = useState<ScreenKind>("unknown");
  const lastKindRef = useRef<ScreenKind>("unknown");

  useEffect(() => {
    let cancelled = false;

    const sample = () => {
      if (cancelled) return;
      const mod = window.Module;
      if (!mod || !mod.ccall) return;
      try {
        const raw = mod.ccall("wmcp_get_state_json", "string", [], []);
        if (typeof raw !== "string" || raw.length === 0) return;
        const parsed = JSON.parse(raw) as Partial<DoomVisionState>;
        const next: ScreenKind =
          (parsed.screen as ScreenKind | undefined) ??
          EMPTY_DOOM_VISION_STATE.screen;
        if (next !== lastKindRef.current) {
          lastKindRef.current = next;
          setKind(next);
        }
      } catch {
        // Engine not ready / mid-frame / malformed JSON. Leave the
        // previous value alone; we'll resample on the next tick.
      }
    };

    // Take an immediate sample so the first render doesn't get stuck on
    // "unknown" for a full poll interval.
    sample();
    const id = window.setInterval(sample, SCREEN_KIND_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return kind;
};

// One component per in-game tool. Each calls its useXxxTool hook
// exactly once; mounting the component registers the tool, unmounting
// it unregisters. Empty render output — these are pure side-effect
// nodes.
const PressKeyTool = () => {
  useInGamePressKeyTool();
  return null;
};
const StartNewGameTool = () => {
  useStartNewGameTool();
  return null;
};
const GetMenuTool = () => {
  useGetMenuTool();
  return null;
};
const PauseTool = () => {
  usePauseTool();
  return null;
};
const QuicksaveTool = () => {
  useQuicksaveTool();
  return null;
};
const QuickloadTool = () => {
  useQuickloadTool();
  return null;
};
const ToggleAutomapTool = () => {
  useToggleAutomapTool();
  return null;
};
const SwitchWeaponTool = () => {
  useSwitchWeaponTool();
  return null;
};
const SayTool = () => {
  useSayTool();
  return null;
};
const GetStateTool = () => {
  useGetStateTool();
  return null;
};
const ScreenshotTool = () => {
  useScreenshotTool();
  return null;
};

/**
 * Mounts the right set of WebMCP tools for the current Doom screen.
 *
 * Gating rules (mirrors the ScreenKind enum in src/lib/doomState.ts):
 *
 *   title          → start_new_game, get_state, get_screenshot, press_key
 *   demo           → start_new_game, get_state, get_screenshot, press_key.
 *                    Attract-mode demo playback looks like gameplay but
 *                    input is ignored. The only useful action is to
 *                    break out into the menu (start_new_game does this
 *                    by sending Esc+Enter; agent can also press_key
 *                    'escape' manually). Gameplay tools are NOT mounted
 *                    here because they'd silently do nothing.
 *   menu           → get_menu, press_key (read the menu, then drive the
 *                    cursor with press_key('up'/'down'/'enter'))
 *   playing        → all gameplay actions (pause, quicksave, quickload,
 *                    toggle_automap, switch_weapon, say) plus press_key,
 *                    get_state, get_screenshot
 *   automap        → pause, toggle_automap (to close), press_key,
 *                    get_state, get_screenshot
 *   intermission   → press_key (to skip), get_state, get_screenshot
 *   dead           → press_key (to respawn / load), quickload,
 *                    get_state, get_screenshot
 *   finale         → press_key (to advance), get_state, get_screenshot
 *   unknown        → press_key, get_state, get_screenshot (safe defaults
 *                    so the agent isn't stuck during boot)
 *
 * press_key, get_state, get_screenshot are universal escape hatches:
 * even if the gating logic ever disagrees with the engine, the agent
 * can fall back to raw keypresses and re-read the engine state.
 *
 * Menu navigation is intentionally agent-driven: get_menu returns the
 * items + cursor position, and press_key('up'/'down'/'enter') moves +
 * activates. There's deliberately no "menu_select(N)" tool because
 * blind-walking the cursor was fragile (couldn't see which item it
 * landed on; couldn't tell when an item was disabled). Reading the
 * menu first means the agent can make grounded decisions and confirm
 * the result.
 */
export const InGameTools = () => {
  const screen = useDoomScreenKind();

  const isMenu = screen === "menu";
  const isPlaying = screen === "playing";
  const isAutomap = screen === "automap";
  const isDead = screen === "dead";
  const isTitle = screen === "title";
  const isDemo = screen === "demo";

  return (
    <>
      {/* Universal — always mounted while the in-game canvas is alive. */}
      <PressKeyTool />
      <GetStateTool />
      <ScreenshotTool />

      {/* Pre-game (title screen) AND attract-mode demo playback both
          benefit from start_new_game: from either, Esc+Enter opens the
          main menu and confirms "New Game". Gameplay tools stay
          unmounted in demo mode so the agent doesn't try to "play"
          frames that ignore its input. */}
      {(isTitle || isDemo) && <StartNewGameTool />}

      {/* Menus: just get_menu. The agent reads the items + cursor and
          drives press_key('up'/'down'/'enter') itself. */}
      {isMenu && <GetMenuTool />}

      {/* Gameplay: full action set. */}
      {isPlaying && <QuicksaveTool />}
      {isPlaying && <SwitchWeaponTool />}
      {isPlaying && <SayTool />}

      {/* Quickload is useful while playing AND while dead (most common
          recovery path). */}
      {(isPlaying || isDead) && <QuickloadTool />}

      {/* Automap can be opened from gameplay and closed from itself.
          Pause also works from the automap, hence the combined gate.
          Render each tool component exactly once per orchestrator
          render — duplicate <PauseTool/> would clobber the WebMCP
          registry entry (it keys on tool name). */}
      {(isPlaying || isAutomap) && <PauseTool />}
      {(isPlaying || isAutomap) && <ToggleAutomapTool />}
    </>
  );
};
