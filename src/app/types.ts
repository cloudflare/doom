import type { RefObject } from "react";

export type Typewriter = (msg: string | string[]) => void;

export type EmscriptenFS = {
  createPreloadedFile: (
    parent: string,
    name: string,
    url: string,
    canRead: boolean,
    canWrite: boolean,
  ) => void;
};

// Subset of Emscripten's `ccall` we use. The full upstream signature
// supports more return types and an options object, but we only ever
// call wmcp_get_state_json() which returns a C string.
export type EmscriptenCcall = (
  ident: string,
  returnType: "string" | "number" | null,
  argTypes: ReadonlyArray<"string" | "number" | "array">,
  args: ReadonlyArray<string | number | Uint8Array>,
) => unknown;

export type EmscriptenModuleConfig = {
  arguments?: string[];
  canvas?: HTMLCanvasElement;
  noInitialRun?: boolean;
  preRun?: () => void;
  postRun?: () => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  setStatus?: (text: string) => void;
  monitorRunDependencies?: (left: number) => void;
  onRuntimeInitialized?: () => void;
  onAbort?: (reason: unknown) => void;
  // Attached by the runtime before preRun fires.
  FS?: EmscriptenFS;
  callMain?: (args: string[]) => unknown;
  calledRun?: boolean;
  // Available after onRuntimeInitialized fires. Exposed by the
  // EXPORTED_RUNTIME_METHODS=ccall flag in doom/src/CMakeLists.txt.
  ccall?: EmscriptenCcall;
  // Direct view into the wasm linear memory, exposed via
  // EXPORTED_RUNTIME_METHODS=HEAPU8. Used by get_screenshot to read the
  // RGBA framebuffer pointed at by wmcp_get_framebuffer_rgba.
  HEAPU8?: Uint8Array;
  // Direct exports, bound after onRuntimeInitialized.
  // wmcp_get_state_json: reads from game globals and returns a JSON
  // string matching DoomVisionState (see doom/src/doom/wmcp_state.c).
  _wmcp_get_state_json?: () => number; // returns char*; use via ccall.
  // wmcp_get_framebuffer_rgba: returns a pointer to a static 320x200
  // RGBA buffer reflecting the most recent rendered frame, with the
  // current gamma-corrected palette applied. 256,000 bytes, row-major,
  // no padding, alpha always 0xFF.
  _wmcp_get_framebuffer_rgba?: () => number;
  // wmcp_get_menu_json: returns a pointer to a static JSON string
  // describing the active menu, or the literal "null" when no menu is
  // open. See doom/src/doom/wmcp_state.c.
  _wmcp_get_menu_json?: () => number;
};

// ---------------------------------------------------------------------------
// nipplejs (loaded as a CDN <script> in index.html — exposed as a global
// on window). Typing kept intentionally minimal: only the surface our
// VirtualJoysticks component touches.
// ---------------------------------------------------------------------------

export type NippleJoystick = {
  on: (
    eventName: string,
    cb: (
      evt: { type: string },
      data: {
        direction?: { angle: "left" | "right" | "up" | "down" };
        distance?: number;
        angle?: { degree: number };
      },
    ) => void,
  ) => NippleJoystick;
  destroy?: () => void;
};

// ---------------------------------------------------------------------------
// Window augmentations for the CDN-loaded globals (chocolate-doom, nipplejs).
// These merge with lib.dom's Window because this file is a module (it has
// exports).
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    Module?: EmscriptenModuleConfig;
    callMain?: (args: string[]) => unknown;
    nipplejs?: {
      create: (opts: {
        zone: HTMLElement;
        color?: string;
        mode?: "static" | "dynamic" | "semi";
        identifier?: number;
        position?: Record<string, string>;
      }) => NippleJoystick;
    };
  }
}

// ---------------------------------------------------------------------------
// Component prop types.
// ---------------------------------------------------------------------------

export type VirtualJoysticksProps = {
  // Canvas the synthetic key events are dispatched on. Same ref the parent
  // hands to chocolate-doom's <canvas>.
  canvasRef: RefObject<HTMLCanvasElement | null>;
  // When false, the component still renders the two #joystick1 / #joystick2
  // anchor divs (the CSS positions them at fixed mobile breakpoints) but
  // skips binding nipplejs. Parents typically pass `true` only on the
  // in-game screen.
  active: boolean;
};
