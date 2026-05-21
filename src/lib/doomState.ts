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

// Player pose, only present while a level is loaded and the player mobj
// exists. Null on title / menu / intermission / finale, and null on the
// frame the player dies until they respawn.
//
// Coordinates are raw Doom map units (the engine's 16.16 fixed-point
// truncated to int). 64 units ~= player bounding-box edge. angle_deg
// is the world-absolute facing in [0, 360), measured the standard Doom
// way: 0 = east, 90 = north, 180 = west, 270 = south.
//
// momx / momy are the *instantaneous* per-tic velocity components in
// map units. They reflect what the engine is about to apply, not what
// it just applied -- friction zeroes them between inputs, so polling
// well after a movement key has been released will read 0,0 even
// though the player did move. To detect "did the agent move?", diff
// player.x/y between successive get_state calls. To detect "am I
// wedged against a wall?", press a movement key and poll *during* the
// hold; if momx == momy == 0, P_TryMove rejected the step.
export type DoomPlayer = {
  x: number;
  y: number;
  z: number;
  angle_deg: number;
  momx: number;
  momy: number;
};

// What a single raycast hit. Distances are in map units (same scale as
// player.x/y). 64 units is roughly "touching"; MISSILERANGE = 2048 is
// the cast horizon, and a ray that reaches the horizon without hitting
// anything reports `hit: "open"` with distance 2048.
//
// bearing_deg uses the screen-space convention (positive = right of
// facing, negative = left), not the BAM convention. The 8 rays are
// spread evenly across the rendered 90-degree FOV, so bearing_deg
// values are { -45, -32, -19, -6, +6, +19, +32, +45 } in order.
export const RAY_HIT_KINDS = [
  "wall",   // one-sided line or impassable / fully-closed two-sided line
  "door",   // door-action line; ray stops here only when door is closed
  "switch", // switch / generic-action line (lifts, floor specials, ...)
  "exit",   // level exit (specials 11, 51, 52, 124)
  "thing",  // first solid mobj along the ray (enemy, barrel, ...)
  "open",   // ray reached max range without a blocking intercept
] as const;
export type RayHitKind = (typeof RAY_HIT_KINDS)[number];

// Coarse category for a visible thing. Lets an agent prioritise
// without keeping an item-name lookup table of its own.
export const THING_CATEGORIES = [
  "enemy",   // a live monster (MF_COUNTKILL, health > 0)
  "weapon",  // shotgun, chaingun, rocket launcher, plasma, BFG, chainsaw
  "ammo",    // clip, ammo box, shell, shell box, rocket, cell, backpack
  "health",  // health bonus, stimpack, medikit, soulsphere, megasphere
  "armor",   // green armour, blue armour, armour bonus (helmet)
  "powerup", // invuln, berserk, rad suit, computer map, light amp
  "key",     // any of the six keycards / skullkeys
  "barrel",  // exploding barrel (shootable, blocks movement)
  "decor",   // solid decoration: column, tech pillar, candle holder, ...
  "unknown", // classified as a thing but unrecognised sprite
] as const;
export type ThingCategory = (typeof THING_CATEGORIES)[number];

export type DoomRaycast = {
  bearing_deg: number;
  distance: number;
  hit: RayHitKind;
  // When hit === "thing", the engine identifies the blocker by sprite
  // and includes its type / category inline. Absent for wall / door /
  // switch / exit / open hits.
  thing_type?: string;
  thing_category?: ThingCategory;
};

// A thing visible along any of the 8 forward-FOV rays, deduped by
// mobj identity across the rays. Covers both solid blockers (the
// pedestal a green armour sits on, exploding barrels, monsters in
// line of sight) and non-solid pickups the ray passes through
// (armour, health, ammo, weapons, keys, powerups).
//
// `distance` is the closest sighting across all rays that crossed
// this thing, and `bearing_deg` is the bearing of that closest ray.
// The array is capped at 16 entries to keep payloads bounded.
export type DoomThingSighting = {
  type: string;
  category: ThingCategory;
  bearing_deg: number;
  distance: number;
};

export type DoomVisionState = {
  screen: ScreenKind;
  // hud is always present but every field can be -1 / "unknown" when the
  // status bar is not visible.
  hud: DoomHud;
  // Spatial pose. Null when a level isn't loaded or the player mobj is
  // absent. Always queried via the same poll as the rest of the state,
  // so player.* and enemies_visible[].* / raycasts[].* are coherent.
  player: DoomPlayer | null;
  // Eight rays across the forward 90-degree FOV. Empty array when no
  // level is loaded or the player is dead. Always exactly 8 entries
  // when populated, ordered left-to-right (most negative bearing first).
  raycasts: DoomRaycast[];
  // All things crossed by any of the 8 forward-FOV rays, deduped by
  // mobj identity, sorted in insertion order (effectively roughly
  // left-to-right then by ray order). Covers pickups, decor and
  // blockers. Capped at 16 entries.
  things_visible: DoomThingSighting[];
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
  player: null,
  raycasts: [],
  things_visible: [],
  enemies_visible: [],
  in_combat: false,
  low_health: false,
  caption: "",
};
