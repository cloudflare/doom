// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
import type {
  Endpoints,
} from "../types";

export const ADJECTIVES = [
  "Grumpy", "Ecstatic", "Surly", "Prepared", "Crafty", "Alert", "Sluggish",
  "Testy", "Reluctant", "Languid", "Passive", "Pacifist", "Aggressive",
  "Hostile", "Bubbly", "Giggly", "Laughing", "Crying", "Frowning", "Torpid",
  "Lethargic", "Manic", "Patient", "Protective", "Philosophical", "Enquiring",
  "Debating", "Furious", "Laid-Back", "Easy-Going", "Cromulent", "Excitable",
  "Tired", "Exhausted", "Ruminating", "Redundant", "Sporty", "Ginger", "Scary",
  "Posh", "Baby",
];

export const NOUNS = [
  "Frad", "Cacodemon", "Arch-Vile", "Cyberdemon", "Imp", "Demon", "Mancubus",
  "Arachnotron", "Baron", "Knight", "Revenant", "Ettin", "Maulotaur",
  "Centaur", "Afrit", "Serpent", "Disciple", "Gargoyle", "Golem", "Lich",
  "Sentinel", "Acolyte", "Templar", "Reaver", "Spectre",
];

export const COMMON_ARGS = [
  "-iwad", "doom1.wad",
  "-window",
  "-nogui",
  "-nomusic",
  "-config", "default.cfg",
  "-servername", "doomflare",
  "-nodes", "4",
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
  console.log("ERROR: WebAssembly not supported.")
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

