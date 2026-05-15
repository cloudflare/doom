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
