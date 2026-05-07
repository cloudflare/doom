// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
import type { Endpoints, DoomHooks, EmscriptenModuleConfig } from "../types";

export const ADJECTIVES = [
  "Grumpy",
  "Ecstatic",
  "Surly",
  "Prepared",
  "Crafty",
  "Alert",
  "Sluggish",
  "Testy",
  "Reluctant",
  "Languid",
  "Passive",
  "Pacifist",
  "Aggressive",
  "Hostile",
  "Bubbly",
  "Giggly",
  "Laughing",
  "Crying",
  "Frowning",
  "Torpid",
  "Lethargic",
  "Manic",
  "Patient",
  "Protective",
  "Philosophical",
  "Enquiring",
  "Debating",
  "Furious",
  "Laid-Back",
  "Easy-Going",
  "Cromulent",
  "Excitable",
  "Tired",
  "Exhausted",
  "Ruminating",
  "Redundant",
  "Sporty",
  "Ginger",
  "Scary",
  "Posh",
  "Baby",
];

export const NOUNS = [
  "Frad",
  "Cacodemon",
  "Arch-Vile",
  "Cyberdemon",
  "Imp",
  "Demon",
  "Mancubus",
  "Arachnotron",
  "Baron",
  "Knight",
  "Revenant",
  "Ettin",
  "Maulotaur",
  "Centaur",
  "Afrit",
  "Serpent",
  "Disciple",
  "Gargoyle",
  "Golem",
  "Lich",
  "Sentinel",
  "Acolyte",
  "Templar",
  "Reaver",
  "Spectre",
];

export const COMMON_ARGS = [
  "-iwad",
  "doom1.wad",
  "-window",
  "-nogui",
  "-nomusic",
  "-config",
  "default.cfg",
  "-servername",
  "doomflare",
  "-nodes",
  "4",
];

export const ROOM_PATTERN = /^[a-z0-9]+-[a-z0-9]+$/;

// The front-end and the API/WebSocket router are now served by the same
// Worker, so every request is same-origin:
//   * `base` is empty so HTTP fetches resolve as origin-relative paths
//     (e.g. "/api/newroom").
//   * `wsbase` is derived from window.location because chocolate-doom's
//     `-wss` argument requires an absolute ws://|wss:// URL.
//   * `web` is the page origin, used for sharable permalinks.
export const ENDPOINTS = ((): Endpoints => {
  if (typeof window === "undefined") {
    return { web: "", base: "", wsbase: "" };
  }
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return {
    web: window.location.origin,
    base: "",
    wsbase: `${wsProto}//${window.location.host}`,
  };
})();

export const hasWebAssembly = (): boolean => {
  try {
    if (
      typeof WebAssembly === "object" &&
      typeof WebAssembly.instantiate === "function"
    ) {
      const bytes = Uint8Array.of(0, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0);
      const mod = new WebAssembly.Module(bytes);
      if (mod instanceof WebAssembly.Module) {
        return new WebAssembly.Instance(mod) instanceof WebAssembly.Instance;
      }
    }
  } catch {
    // ignore
  }
  console.log("ERROR: WebAssembly not supported.");
  return false;
};

export const isMobile = (): boolean => {
  const tests = [
    /Android/i,
    /webOS/i,
    /iPhone/i,
    /iPad/i,
    /iPod/i,
    /BlackBerry/i,
    /Windows Phone/i,
  ];
  return tests.some((re) => navigator.userAgent.match(re) !== null);
};

export const genPetName = (): string => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
};

// Boot Chocolate Doom (classic Emscripten bundle).
//
// The /chocolate-doom.js script auto-runs on load and reads its config from
// the pre-existing global `Module`. The script can only be initialised once
// per page, so a second boot in the same session forces a hard reload — this
// matches the original silentspacemarine.com behaviour.

let bootedOnce = false;

export const bootDoom = (
  args: string[],
  canvas: HTMLCanvasElement,
  print: any,
): Promise<void> => {
  if (bootedOnce) {
    // The classic Emscripten bundle has already auto-run; we cannot
    // re-initialise it. Force a fresh page so the user can start over.
    window.location.reload();
    return new Promise<void>(() => {
      /* never resolves; reload is in flight */
    });
  }
  bootedOnce = true;

  return new Promise<void>((resolve, reject) => {
    const config: EmscriptenModuleConfig = {
      canvas,
      arguments: args,
      noInitialRun: true,
      preRun: () => {
        const fs = window.Module?.FS;
        if (!fs) {
          console.error(
            "Doom preRun: FS not attached yet - cannot preload WAD",
          );
          return;
        }
        fs.createPreloadedFile("", "doom1.wad", "doom1.wad", true, true);
        fs.createPreloadedFile("", "default.cfg", "default.cfg", true, true);
      },
      onRuntimeInitialized: () => {
        // Mirror the reference index.html: explicit callMain after init.
        const main = window.Module?.callMain ?? window.callMain;
        if (typeof main !== "function") {
          reject(new Error("callMain not exposed by chocolate-doom.js"));
          return;
        }
        try {
          main(args);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      print,
      printErr: (text) => {
        console.error(text);
      },
      setStatus: (text) => {
        console.error(text);
      },
      monitorRunDependencies: () => {
        /* status handled by setStatus */
      },
      onAbort: (reason) => {
        console.log(reason);
        reject(
          reason instanceof Error
            ? reason
            : new Error(`Doom aborted: ${String(reason)}`),
        );
      },
    };

    window.Module = config;

    const script = document.createElement("script");
    script.src = "/chocolate-doom.js";
    script.async = true;
    script.onerror = () =>
      reject(new Error("Failed to load /chocolate-doom.js"));
    document.head.appendChild(script);
  });
};
