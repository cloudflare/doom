import type { RefObject } from "react";

// ---------------------------------------------------------------------------
// Emscripten / chocolate-doom (loaded from /chocolate-doom.js, classic
// non-MODULARIZE build). The bundle reads a pre-existing global `Module`
// for its config and auto-runs as soon as it loads, attaching helpers
// (FS, callMain, ...) onto that same object once initialised.
// ---------------------------------------------------------------------------

export type EmscriptenFS = {
  createPreloadedFile: (
    parent: string,
    name: string,
    url: string,
    canRead: boolean,
    canWrite: boolean,
  ) => void;
};

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
};

// Hook subset the Game component supplies to bootDoom().
export type DoomHooks = {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  setStatus?: (text: string) => void;
  onAbort?: (reason: unknown) => void;
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
// Networking endpoints (computed once at module load in Game.tsx).
// ---------------------------------------------------------------------------

export type Endpoints = {
  // Page origin used to build sharable permalinks.
  web: string;
  // Empty in production so HTTP fetches resolve as origin-relative paths.
  base: string;
  // Absolute ws://|wss:// origin — chocolate-doom's `-wss` arg requires a
  // fully-qualified WebSocket URL.
  wsbase: string;
};

// ---------------------------------------------------------------------------
// Screen state machine for the Game component.
// ---------------------------------------------------------------------------

export type Screen =
  | { kind: "noWasm" }
  | { kind: "mobileInfo" }
  | { kind: "home" }
  | { kind: "validating" }
  | { kind: "invalid" }
  | { kind: "tooLate" }
  | {
      kind: "choosePet";
      mode: "host" | "join";
      // For "join", we already know the room.
      room?: string;
    }
  | { kind: "deathmatchOr"; pet: string; room: string }
  | {
      kind: "permalink";
      room: string;
      args: string[];
    }
  | { kind: "game"; args: string[] };

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

export type NoWasmViewProps = {
  footerRef: RefObject<HTMLDivElement | null>;
  footerHtml: string;
};

export type MenuContentProps = {
  screen: Screen;
  petName: string;
  setPetName: (v: string) => void;
  onSolo: () => void;
  onMultiplayer: () => void;
  onChoosePetSubmit?: (pet: string) => void;
  onDeathmatchChoice?: (deathmatch: boolean) => void;
  onPermalinkStart?: () => void;
};

export type HomeMenuProps = {
  onSolo: () => void;
  onMultiplayer: () => void;
};

export type TextMenuProps = {
  screen: Extract<Screen, { kind: "validating" | "tooLate" | "invalid" }>;
};

export type ChoosePetMenuProps = {
  petName: string;
  setPetName: (v: string) => void;
  onSubmit: (pet: string) => void;
};

export type DeathmatchOrMenuProps = {
  onChoice: (dm: boolean) => void;
};

export type PermalinkMenuProps = {
  room: string;
  onStart: () => void;
};
