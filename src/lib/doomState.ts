// Shape of the structured game state returned by the WebMCP `get_state`
// tool (src/app/lib/webmcp.tsx), which in turn calls the C function
// `wmcp_get_state_json` (doom/src/doom/wmcp_state.c) via Emscripten's
// ccall.
//
// The C side hand-mirrors the schema below. Any change to a field name
// or enum value has to land in both files in the same commit, and the
// Doom wasm has to be rebuilt (`make doom-build && make doom-copy`).
// There is no automatic codegen — the C builder uses snprintf and the
// JS side uses JSON.parse, so a mismatch shows up as a malformed
// DoomVisionState at runtime rather than a build error.
//
// Bearings and distances are deliberately coarse bins, not pixel /
// fixed-point values, because that's the resolution at which an agent
// makes useful tactical decisions. Bearings are computed relative to
// `players[consoleplayer].mo->angle` and clipped to the forward
// 180-degree arc.

export const SCREEN_KINDS = [
  "title", // title screen / studio splash
  "menu", // any in-game or pre-game menu (episode, skill, options, save, load)
  "playing", // first-person 3D view, in-game, agent in control
  "demo", // attract-mode demo playback — looks like gameplay but input is ignored
  "automap", // top-down map view
  "intermission", // between-level stats screen
  "dead", // post-death view (body on ground, "press use")
  "finale", // end-of-episode text crawl
  "unknown",
] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

export const WEAPONS = [
  "fist",
  "chainsaw",
  "pistol",
  "shotgun",
  "super_shotgun",
  "chaingun",
  "rocket_launcher",
  "plasma_rifle",
  "bfg",
  "unknown",
] as const;
export type Weapon = (typeof WEAPONS)[number];

export const AMMO_TYPES = [
  "bullets",
  "shells",
  "rockets",
  "cells",
  "none", // fists / chainsaw
  "unknown",
] as const;
export type AmmoType = (typeof AMMO_TYPES)[number];

export const FACE_STATES = [
  "ok", // 80%-100% health, neutral
  "hurt", // visibly damaged
  "evil_grin", // just picked up a weapon
  "rampage", // continuous fire
  "god", // god-mode (golden)
  "dead", // skull / dead face
  "unknown",
] as const;
export type FaceState = (typeof FACE_STATES)[number];

export const KEYS = [
  "blue_keycard",
  "yellow_keycard",
  "red_keycard",
  "blue_skull",
  "yellow_skull",
  "red_skull",
] as const;
export type Key = (typeof KEYS)[number];

export const ENEMY_TYPES = [
  "zombieman", // former human
  "shotgun_guy", // former sergeant
  "imp",
  "demon", // pinky
  "spectre",
  "lost_soul",
  "cacodemon",
  "baron_of_hell",
  "knight_of_hell",
  "revenant",
  "mancubus",
  "arachnotron",
  "pain_elemental",
  "archvile",
  "cyberdemon",
  "spider_mastermind",
  "other", // any enemy we can see but cannot classify
  "unknown",
] as const;
export type EnemyType = (typeof ENEMY_TYPES)[number];

export const BEARINGS = [
  "far_left",
  "left",
  "center",
  "right",
  "far_right",
] as const;
export type Bearing = (typeof BEARINGS)[number];

export const DISTANCES = ["near", "mid", "far", "unknown"] as const;
export type Distance = (typeof DISTANCES)[number];

export type DoomEnemySighting = {
  type: EnemyType;
  bearing: Bearing;
  distance: Distance;
};

export type DoomHud = {
  // Numeric fields are integers 0-999. The engine emits -1 when a field
  // is not visible (e.g. status bar hidden, automap, menu).
  health: number;
  armor: number;
  ammo: number;
  ammo_type: AmmoType;
  weapon: Weapon;
  face_state: FaceState;
  keys: Key[];
};

export type DoomVisionState = {
  screen: ScreenKind;
  // hud is always present but every field can be -1 / "unknown" when the
  // status bar is not visible.
  hud: DoomHud;
  enemies_visible: DoomEnemySighting[];
  // High-level booleans the agent loop cares about, derived engine-side.
  in_combat: boolean;
  low_health: boolean; // true when health <= 30 and visible
  // Short summary string (<= 80 chars). Useful for logs/TTS even when the
  // structured fields are partly empty.
  caption: string;
};

// Default state. Used by `get_state` as the seed for the defensive
// merge: if the C side ever omits a field (e.g. a schema update lands
// engine-side before this TS file catches up), the agent still gets a
// complete object.
export const EMPTY_DOOM_VISION_STATE: DoomVisionState = {
  screen: "unknown",
  hud: {
    health: -1,
    armor: -1,
    ammo: -1,
    ammo_type: "unknown",
    weapon: "unknown",
    face_state: "unknown",
    keys: [],
  },
  enemies_visible: [],
  in_combat: false,
  low_health: false,
  caption: "",
};
