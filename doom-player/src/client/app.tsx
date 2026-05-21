import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";

// Simple default bot: walks forward for ten ticks, logging HP and
// screen each step. Designed to be the smallest useful demonstration
// of the codemode API; the "Examples" picker offers more involved
// bots for users to graduate to.
const SIMPLE_BOT = `// A minimal codemode bot. The game is already past the menus when
// this code starts, so we can read state and press keys right away.
//
// API (all async, always 'await'):
//   await bot.getState()            // engine snapshot (hud, screen, ...)
//   await bot.press(key, holdMs?)   // key tap or hold
//   await bot.sleep(ms)             // pause between actions
//   await bot.log(...args)          // streamed live to the log pane

for (let i = 0; i < 10; i++) {
  const s = await bot.getState();
  await bot.log("tick", i, "screen:", s.screen, "hp:", s.hud.health);
  await bot.press("up", 250); // walk forward for 250ms
  await bot.sleep(50);
}

return "walked 10 steps";
`;

// More involved example: handles non-playing screens, fires at any
// enemy directly ahead, and walks forward otherwise. Closer in spirit
// to what a real bot looks like.
const COMBAT_BOT = `// Walk forward and shoot enemies in the centre of the FOV.
for (let i = 0; i < 40; i++) {
  const s = await bot.getState();
  await bot.log("tick", i, "screen:", s.screen, "hp:", s.hud.health,
    "enemies:", s.enemies_visible.length);

  // Press enter on menu / intermission / finale to advance.
  if (s.screen !== "playing") {
    await bot.press("enter");
    await bot.sleep(150);
    continue;
  }

  const centred = s.enemies_visible.find((e) => e.bearing === "center");
  if (centred) {
    await bot.log("firing at", centred.type);
    await bot.press("fire", 200);
  }
  await bot.press("up", 250);
  await bot.sleep(50);
}

return "combat run complete";
`;

// Full deterministic auto-player. Faithful port of the original
// host-side /play loop into a single codemode bot. Priority-ordered
// playing policy: fire centred enemies → turn toward off-centre
// enemies → unstick → open doors / switches → take exits → grab
// useful pickups → navigate toward the deepest open ray. Designed
// to clear a level autonomously without an LLM in the loop.
const AUTOPLAY_BOT = `// Deterministic Doom auto-player.
//
// Priority each tick (highest first):
//   1. Centre-FOV enemy           -> fire
//   2. Off-centre enemy           -> turn toward it
//   3. Hard wedge (>=6 stationary ticks) -> 700ms right turn
//   4. Door / switch ahead, close -> press use, step forward
//   4b. Door / switch off-centre  -> turn toward it (approach)
//   5. Exit at <=200 units        -> press use, step forward
//   6. Useful pickup              -> turn toward / approach it (sticky)
//   7. Soft wedge (>=3 stationary ticks) -> 350ms right turn
//   8. Navigate                   -> follow deepest open ray
//
// Tuning constants -- tweak these to change behaviour.
const MAX_TICKS = 400;
const TICK_MS = 250;

// Wedge detection: ticks before nudging / spinning when motion stalls.
const SOFT_WEDGE_TICKS = 3;
const HARD_WEDGE_TICKS = 6;
// Squared distance below which a frame counts as "didn't move"
// (player radius is 16; 32^2 filters out grazing micro-motion).
const WEDGE_EPSILON_SQ = 32 * 32;

// Cooldown ticks after pressing use on a door / after an unwedge
// nudge, to avoid spamming use while the door animates open or
// re-targeting the same unreachable pickup we just spun away from.
const DOOR_COOLDOWN = 4;
const UNWEDGE_COOLDOWN = 3;

// Sticky pickup target lifetime (ticks before we give up on the
// type we locked onto and let other policies run).
const PICKUP_LIFETIME = 20;

// Category priorities. Lower = preferred.
const PICKUP_PRIORITY = {
  key: 0,
  weapon: 1,
  powerup: 2,
  armor: 3,
  health: 4,
  ammo: 5,
};

// --- Pure helpers ----------------------------------------------------

function turnKeyForBearing(bearing) {
  if (bearing === "far_left" || bearing === "left") return "left";
  if (bearing === "right" || bearing === "far_right") return "right";
  return null;
}

function bearingScore(bearing) {
  if (bearing === "center") return 0;
  if (bearing === "left" || bearing === "right") return 1;
  return 2;
}

function distanceScore(distance) {
  if (distance === "near") return 0;
  if (distance === "mid") return 1;
  if (distance === "far") return 2;
  return 3;
}

function pickClosestEnemy(enemies) {
  const sorted = [...enemies].sort((a, b) => {
    const ab = bearingScore(a.bearing) - bearingScore(b.bearing);
    if (ab !== 0) return ab;
    return distanceScore(a.distance) - distanceScore(b.distance);
  });
  return sorted[0];
}

function bearingTurnMs(bearing) {
  if (bearing === "left" || bearing === "right") return 140;
  if (bearing === "far_left" || bearing === "far_right") return 320;
  return 0;
}

function pickupIsUseful(thing, hud) {
  if (!(thing.category in PICKUP_PRIORITY)) return false;
  if (thing.category === "health") {
    if (thing.type === "stimpack" || thing.type === "medikit") {
      return hud.health < 100;
    }
    return hud.health < 200;
  }
  if (thing.category === "armor") {
    if (thing.type === "green_armor") return hud.armor < 100;
    if (thing.type === "blue_armor") return hud.armor < 200;
    return hud.armor < 200;
  }
  return true;
}

function pickPickup(things, hud) {
  const useful = things.filter((t) => pickupIsUseful(t, hud));
  if (useful.length === 0) return undefined;
  useful.sort((a, b) => {
    const ap = PICKUP_PRIORITY[a.category] ?? 99;
    const bp = PICKUP_PRIORITY[b.category] ?? 99;
    if (ap !== bp) return ap - bp;
    return a.distance - b.distance;
  });
  return useful[0];
}

// --- Action helpers --------------------------------------------------

async function approach(bearing_deg, distance) {
  const abs = Math.abs(bearing_deg);
  if (abs > 10) {
    const key = bearing_deg < 0 ? "left" : "right";
    const ms = Math.min(500, Math.max(60, abs * 5));
    await bot.press(key, ms);
    return "turn:" + key;
  }
  const ms = Math.min(800, Math.max(150, distance * 2));
  await bot.press("forward", ms);
  return "forward";
}

async function navigate(state) {
  const rays = state.raycasts;
  if (rays.length === 0) {
    await bot.press("forward", 200);
    return "blind_forward";
  }
  const ranked = [...rays].sort((a, b) => {
    const w = (r) => (r.hit === "open" ? r.distance + 2000 : r.distance);
    return w(b) - w(a);
  });
  const best = ranked[0];
  const centre = rays
    .filter((r) => Math.abs(r.bearing_deg) <= 20)
    .sort((a, b) => b.distance - a.distance)[0];
  if (centre && centre.distance >= 200) {
    await bot.press("forward", 400);
    return "navigate_forward(" + centre.distance + ")";
  }
  return await approach(best.bearing_deg, best.distance);
}

// --- Main loop -------------------------------------------------------

const actions = {};
const bump = (name) => {
  actions[name] = (actions[name] ?? 0) + 1;
};

// Per-loop mutable state (replaces the DoomPlayer private fields).
let lastPos = null;
let stuckTicks = 0;
let doorCooldown = 0;
let unwedgeCooldown = 0;
let pickupTarget = null;

function updateWedge(pose) {
  if (!pose) {
    stuckTicks = 0;
    return;
  }
  if (lastPos === null) {
    lastPos = { x: pose.x, y: pose.y };
    stuckTicks = 0;
    return;
  }
  const dx = pose.x - lastPos.x;
  const dy = pose.y - lastPos.y;
  const moved = dx * dx + dy * dy;
  lastPos = { x: pose.x, y: pose.y };
  if (moved < WEDGE_EPSILON_SQ) {
    stuckTicks++;
  } else {
    stuckTicks = 0;
  }
}

async function playStep(state) {
  if (doorCooldown > 0) doorCooldown--;
  if (unwedgeCooldown > 0) unwedgeCooldown--;
  updateWedge(state.player);
  const wedgedSoft = stuckTicks >= SOFT_WEDGE_TICKS;
  const wedgedHard = stuckTicks >= HARD_WEDGE_TICKS;

  if (pickupTarget) {
    const stillVisible = state.things_visible.some(
      (t) => t.type === pickupTarget.type,
    );
    if (!stillVisible) {
      pickupTarget = null;
    } else {
      pickupTarget.ticksRemaining--;
      if (pickupTarget.ticksRemaining <= 0) pickupTarget = null;
    }
  }

  // 1. Centre enemy -> fire.
  const centre = state.enemies_visible.find((e) => e.bearing === "center");
  if (centre) {
    await bot.press("fire", 120);
    pickupTarget = null;
    return "fire:" + centre.type;
  }

  // 2. Off-centre enemy -> turn toward.
  const off = pickClosestEnemy(state.enemies_visible);
  if (off) {
    const key = turnKeyForBearing(off.bearing);
    if (key) {
      await bot.press(key, bearingTurnMs(off.bearing));
      pickupTarget = null;
      return "aim_enemy:" + off.bearing;
    }
  }

  // 3. Hard wedge -> big right turn.
  if (wedgedHard) {
    await bot.press("right", 700);
    stuckTicks = 0;
    pickupTarget = null;
    unwedgeCooldown = UNWEDGE_COOLDOWN;
    return "unwedge_hard";
  }

  // 4. Door / switch handling. Doom's "use" key activates both:
  //    - door lines (open / close / lock-and-unlock)
  //    - switch lines (raise lifts, open remote doors, end-level
  //      switches that aren't tagged as exits, etc.)
  //    Both surface through raycasts as hit="door" or hit="switch".
  //    Treat them the same: walk up, press use.
  //
  //    Pick the ray with the smallest off-centre bearing first; if
  //    multiple usable lines are in view, the most-aligned one is
  //    usually the one the level designer intended us to interact
  //    with.
  const usableRays = state.raycasts
    .filter((r) => r.hit === "door" || r.hit === "switch")
    .sort((a, b) => Math.abs(a.bearing_deg) - Math.abs(b.bearing_deg));
  const usableRay = usableRays[0];
  if (usableRay && doorCooldown === 0) {
    const aligned = Math.abs(usableRay.bearing_deg) <= 15;
    // 4a. Close + roughly centred -> press use, step through.
    if (aligned && usableRay.distance <= 80) {
      await bot.press("use", 80);
      await bot.press("forward", 300);
      doorCooldown = DOOR_COOLDOWN;
      return "open_" + usableRay.hit + "(d=" + usableRay.distance + ")";
    }
    // 4b. Within reach but not yet aligned / close -> approach.
    //     Skip while wedged so we don't fight the unstick logic.
    if (!wedgedSoft && usableRay.distance <= 400) {
      const action = await approach(usableRay.bearing_deg, usableRay.distance);
      // Drop any pickup lock; doors/switches usually gate progress.
      pickupTarget = null;
      return "approach_" + usableRay.hit + "(" + action + ")";
    }
  }

  // 5. Exit close ahead -> use, step forward.
  const exitRay = state.raycasts.find(
    (r) => r.hit === "exit" && r.distance <= 200,
  );
  if (exitRay) {
    await bot.press("use", 80);
    await bot.press("forward", 400);
    return "exit_level(d=" + exitRay.distance + ")";
  }

  // 6. Pickup approach (sticky).
  if (!wedgedSoft && unwedgeCooldown === 0) {
    let target = null;
    if (pickupTarget) {
      const current = state.things_visible.find(
        (t) => t.type === pickupTarget.type,
      );
      if (current && pickupIsUseful(current, state.hud)) {
        target = current;
      } else {
        pickupTarget = null;
      }
    }
    if (!target) {
      target = pickPickup(state.things_visible, state.hud);
      if (target) {
        pickupTarget = { type: target.type, ticksRemaining: PICKUP_LIFETIME };
      }
    }
    if (target) {
      const action = await approach(target.bearing_deg, target.distance);
      return "grab:" + target.type + "(" + action + ")";
    }
  }

  // 7. Soft wedge -> shorter right turn.
  if (wedgedSoft) {
    await bot.press("right", 350);
    pickupTarget = null;
    return "unwedge_soft";
  }

  // 8. General navigation.
  return await navigate(state);
}

let lastScreen = "unknown";
let lastHp = -1;

for (let tick = 1; tick <= MAX_TICKS; tick++) {
  let state;
  try {
    state = await bot.getState();
  } catch (err) {
    // Engine may briefly fail get_state during screen transitions.
    await bot.log("t=" + tick, "wait_no_state", String(err.message ?? err));
    bump("wait_no_state");
    await bot.sleep(TICK_MS);
    continue;
  }

  lastScreen = state.screen;
  lastHp = state.hud.health;

  let action;
  switch (state.screen) {
    case "intermission":
    case "finale":
      await bot.press("enter");
      action = "advance_intermission";
      break;
    case "dead":
      await bot.press("use");
      action = "respawn";
      break;
    case "automap":
      await bot.press("tab");
      action = "close_automap";
      break;
    case "playing":
      action = await playStep(state);
      break;
    case "title":
    case "demo":
    case "menu":
      // Shouldn't happen post-preroll, but be defensive: try enter.
      await bot.press("enter");
      action = "menu_enter";
      break;
    default:
      action = "wait_unknown";
      await bot.sleep(100);
      break;
  }
  bump(action);

  // Log only interesting events every tick; throttle navigation /
  // wait actions to every 10 ticks so the stream stays scannable.
  const interesting =
    action.startsWith("fire") ||
    action.startsWith("open_door") ||
    action.startsWith("open_switch") ||
    action.startsWith("approach_door") ||
    action.startsWith("approach_switch") ||
    action.startsWith("exit_level") ||
    action.startsWith("grab:") ||
    action.startsWith("aim_enemy") ||
    action.startsWith("unwedge") ||
    action === "respawn" ||
    action === "advance_intermission" ||
    action === "wait_no_state" ||
    state.screen !== "playing";
  if (interesting || tick % 10 === 0) {
    const pos = state.player
      ? " pos=(" + state.player.x + "," + state.player.y + ") ang=" + state.player.angle_deg
      : "";
    await bot.log(
      "t=" + String(tick).padStart(3, " "),
      "screen=" + state.screen,
      "action=" + action,
      "hp=" + state.hud.health,
      "armor=" + state.hud.armor,
      "ammo=" + state.hud.ammo,
      "enemies=" + state.enemies_visible.length,
      "things=" + state.things_visible.length + pos,
    );
  }

  await bot.sleep(TICK_MS);
}

const summary = Object.entries(actions)
  .sort(([, a], [, b]) => b - a)
  .map(([n, c]) => n + "=" + c)
  .join(" ");
await bot.log("done; finalScreen=" + lastScreen, "finalHp=" + lastHp);
await bot.log("actions:", summary);
return { ticks: MAX_TICKS, finalScreen: lastScreen, finalHp: lastHp, actions };
`;

// One-shot diagnostic bot: dumps the first state snapshot and exits.
// Useful for inspecting what fields the engine exposes without
// writing a loop.
const INSPECT_BOT = `// Dump a single state snapshot and the current frame, then quit.
// Useful for sanity-checking what the engine exposes.
await bot.log(JSON.stringify(await bot.getState(), null, 2));
// The screenshot lands in the collapsible image panel on the right.
const shot = await bot.screenshot();
await bot.logImage(shot, "inspect: current frame");
`;

// Vision-LLM bot: opens the automap, screenshots it, asks Workers AI
// where to go, and moves in that direction. Requires the optional
// `ai` namespace (host worker must have the AI binding configured).
//
// API used:
//   await bot.screenshot()  -> { data: base64-png, mimeType }
//   await ai.run(model, input)
const AI_NAV_BOT = `// Hybrid AI navigation with closed-loop steering.
//
// One macro consult: open the automap, screenshot it, ask the vision
// LLM for a *player-relative* turn (AHEAD / SOFT_LEFT / HARD_LEFT /
// SOFT_RIGHT / HARD_RIGHT / BACK). Combine it with the player's current
// facing to compute a target world bearing.
//
// Many micro ticks: read get_state every tick, compute the angular
// error between the current player.angle_deg and the target bearing,
// and correct it (turn left/right) before walking forward. Combat /
// door / pinned / stuck / wall overrides preempt steering.
//
// Idea: the LLM is slow and expensive, so we only use it to answer the
// hard question — "given the whole map, which way should I be heading?"
// Everything else (shooting enemies in the FOV, opening doors, not
// walking into walls) is done locally from the raycast + thing data
// in get_state, tick-by-tick.
//
// Requires the host worker to have the optional Workers AI binding
// configured (see doom-player wrangler.jsonc \`ai\` block). Without
// it, \`ai\` is undefined in this sandbox and the call below throws.

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const STEPS = 5;                // macro consults of the vision LLM
const TICKS_PER_MACRO = 24;     // micro ticks between consults
const TICK_MS = 200;
const TURN_TOLERANCE_DEG = 18;  // dead-band: don't bother correcting <18°
const TURN_HOLD_MIN_MS = 140;   // shortest turn tap
const TURN_HOLD_MAX_MS = 500;   // longest single turn tap (big errors)
// Every field returned by get_state is a snapshot of the last completed
// 35Hz engine tic (see the \`get_state\` tool description in
// src/app/lib/webmcp.tsx). After a press_key our keydown -> ticcmd ->
// thrust pipeline can leave the next get_state still showing the
// previous tic's pose, raycasts, momx/momy, things, etc.
//
// momx/momy are the most visibly laggy because they require the thrust
// step to have run, but x/y/angle/raycasts can also briefly trail.
// Position eventually becomes ground truth because the displacement
// from a press accumulates over multiple tics, so deltas between two
// consecutive reads are a reliable "did anything happen?" signal even
// when one read is stale. We use position-delta-over-multiple-ticks
// for wedge detection; momentum is just logged for context.
const STUCK_POS_EPS = 4;        // units of pos delta below this = stuck
const STUCK_TICKS = 3;          // consecutive stuck ticks before unsticking
// Kept for the per-tick log and steady-state speed estimates only;
// not used for wedge detection any more.
const STUCK_MOM_EPS = 0.5;

// @cf/meta/llama-3.2-11b-vision-instruct requires that you agree with their terms
await ai.run(MODEL, { prompt: "agree" }).catch(() => {});

// ── Heading helpers ──────────────────────────────────────────────────
//
// Earlier versions of this bot treated the automap as world-axis-
// aligned and asked the LLM for a screen-space 3x3 cell, then converted
// that to an absolute world bearing. That was wrong in practice: the
// player ARROW on the automap rotates with the player's facing, so the
// LLM naturally reads the map relative to the arrow ("the open corridor
// is ahead and to the right of the player"). Converting its answer as
// an absolute world direction made the bot turn the wrong way whenever
// the player wasn't already facing north.
//
// We now ask the LLM for a *player-relative* turn (AHEAD / SOFT_LEFT /
// HARD_LEFT / SOFT_RIGHT / HARD_RIGHT / BACK) and compute the target
// world bearing as \`player.angle + relative_offset\`. No screen-to-world
// conversion needed.
const RELATIVE_TURNS = {
  AHEAD:       0,
  SOFT_LEFT:  45,
  HARD_LEFT:  90,
  BACK:      180,
  HARD_RIGHT: -90,
  SOFT_RIGHT: -45,
};

// Signed angular delta in degrees, result in (-180, 180].
function angleDelta(targetDeg, currentDeg) {
  let d = (targetDeg - currentDeg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

// Cardinal label for a world bearing (Doom convention: 0°=E, 90°=N).
// Lets us log human-readable directions alongside raw degrees so traces
// stay readable without doing degree arithmetic in your head.
function compassLabel(deg) {
  const d = normalizeAngle(deg);
  const labels = [
    ["E", 0], ["NE", 45], ["N", 90], ["NW", 135],
    ["W", 180], ["SW", 225], ["S", 270], ["SE", 315],
  ];
  let best = labels[0];
  let bestDelta = 360;
  for (const [name, ref] of labels) {
    const delta = Math.min(
      Math.abs(d - ref),
      360 - Math.abs(d - ref),
    );
    if (delta < bestDelta) {
      bestDelta = delta;
      best = [name, ref];
    }
  }
  return best[0];
}

// Linearly interpolate the engine's 8 forward raycasts to estimate
// what's at an arbitrary player-relative bearing. Used by the veto
// check after the LLM picks a turn — if the predicted slot is a close
// wall we override to BACK rather than walking into geometry.
function predictRayAt(rays, relBearingDeg) {
  if (!rays || rays.length === 0) return null;
  // Find the two nearest rays by bearing.
  let nearest = rays[0];
  let nearestDelta = Infinity;
  for (const r of rays) {
    const delta = Math.abs(r.bearing_deg - relBearingDeg);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = r;
    }
  }
  return nearest;
}

// Build a compact, structured prose digest of the current engine
// state for the LLM. All directional fields are *player-relative*
// (matches the turn-direction question we're about to ask). The
// digest is intentionally line-oriented so the model can scan it.
function buildStatePrompt(state, history) {
  const p = state.player;
  const facingStr = p
    ? \`\${p.angle_deg.toFixed(0)}° (\${compassLabel(p.angle_deg)})\`
    : "(unknown)";
  const poseStr = p
    ? \`(\${p.x.toFixed(0)}, \${p.y.toFixed(0)})\`
    : "(unknown)";

  const rays = state.raycasts || [];
  const raysSorted = [...rays].sort((a, b) => a.bearing_deg - b.bearing_deg);
  const rayLines = raysSorted.map((r) => {
    const sign = r.bearing_deg >= 0 ? "+" : "";
    const extra = r.thing_type ? \` (\${r.thing_type})\` : "";
    return \`  \${sign}\${r.bearing_deg.toFixed(0).padStart(3, " ")}°: \${r.hit} @ \${r.distance.toFixed(0)}\${extra}\`;
  }).join("\\n");

  const things = (state.things_visible || []).slice(0, 8).map((t) => {
    const sign = t.bearing_deg >= 0 ? "+" : "";
    return \`\${t.type} @ \${sign}\${t.bearing_deg.toFixed(0)}°/\${t.distance.toFixed(0)}\`;
  }).join(", ");

  const enemies = (state.enemies_visible || []).map(
    (e) => \`\${e.type} @ \${e.bearing}/\${e.distance}\`,
  ).join(", ");

  const hud = state.hud;
  const hudStr = \`hp=\${hud.health} armor=\${hud.armor} ammo=\${hud.ammo}(\${hud.ammo_type}) weapon=\${hud.weapon} keys=[\${(hud.keys || []).join(",")}]\`;

  const historyLines = [];
  if (history && history.recent && history.recent.length > 0) {
    for (const h of history.recent) {
      historyLines.push(
        \`  macro \${h.macro}: picked \${h.turn}, moved \${h.dist.toFixed(0)} units\${h.pinned ? " (pinned)" : ""}\`,
      );
    }
  }

  return [
    "ENGINE STATE (all bearings are relative to player facing; -=left, +=right):",
    \`  facing: \${facingStr}\`,
    \`  pose:   \${poseStr}\`,
    \`  hud:    \${hudStr}\`,
    "  forward-cone raycasts:",
    rayLines || "    (none)",
    \`  things visible: \${things || "(none)"}\`,
    \`  enemies visible: \${enemies || "(none)"}\`,
    historyLines.length > 0
      ? "RECENT MACRO HISTORY:\\n" + historyLines.join("\\n")
      : "RECENT MACRO HISTORY: (this is the first macro)",
  ].join("\\n");
}

// Convert base64 PNG -> number[] (Workers AI vision input shape).
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Capture the automap as a screenshot. The automap is a toggle (Tab),
// so we open it, wait a tic for redraw, snap, then close it again so
// regular movement keys go back to controlling the player.
async function snapAutomap(currentScreen) {
  if (currentScreen !== "automap") {
    await bot.press("tab");
    await bot.sleep(150);
  }
  const shot = await bot.screenshot();
  await bot.press("tab");
  await bot.sleep(100);
  return shot;
}

// Ask the vision LLM which way to turn next, relative to the player
// arrow on the automap. The prompt fuses the rendered automap (image)
// with a structured digest of the engine state (text), so the model
// can cross-reference what it "sees" with what raycasts actually show.
async function askMacroTurn(state, shot, history) {
  const stateBlock = buildStatePrompt(state, history);
  const instructions =
    "You are guiding a DOOM bot. The IMAGE is the in-game automap: " +
    "white lines are explored walls; the small white triangle at the " +
    "centre is the PLAYER and its tip points the way the player faces. " +
    "Black space adjacent to white walls is unexplored territory.\\n\\n" +
    stateBlock +
    "\\n\\nDecide where the player should head next, *relative to the " +
    "arrow's current facing*. Use BOTH the map (for big-picture " +
    "exploration) AND the raycasts (for what's physically reachable " +
    "this second). Prefer a direction where the raycasts are open " +
    "(distance > 100, hit != wall). Avoid picking a direction the " +
    "raycasts show as a close wall. If the recent history shows the " +
    "bot was pinned moving the same way, pick a DIFFERENT direction " +
    "this time.\\n\\n" +
    "Reply with EXACTLY one token from this set, nothing else: " +
    "AHEAD, SOFT_LEFT, HARD_LEFT, SOFT_RIGHT, HARD_RIGHT, BACK.\\n" +
    "  AHEAD       = keep current facing\\n" +
    "  SOFT_LEFT   = rotate ~45° counter-clockwise\\n" +
    "  HARD_LEFT   = rotate ~90° counter-clockwise\\n" +
    "  SOFT_RIGHT  = rotate ~45° clockwise\\n" +
    "  HARD_RIGHT  = rotate ~90° clockwise\\n" +
    "  BACK        = turn around (~180°)";

  const t0 = Date.now();
  const resp = await ai.run(MODEL, {
    image: base64ToBytes(shot.data),
    prompt: instructions,
    max_tokens: 12,
  });
  const elapsedMs = Date.now() - t0;
  const text = (resp && typeof resp === "object" && typeof resp.response === "string")
    ? resp.response.trim()
    : String(resp);
  const upper = text.toUpperCase();
  // Longest tokens first so "HARD_LEFT" doesn't match the "LEFT" branch.
  let pick = "AHEAD";
  for (const k of ["HARD_LEFT", "HARD_RIGHT", "SOFT_LEFT", "SOFT_RIGHT", "BACK", "AHEAD"]) {
    if (upper.includes(k)) { pick = k; break; }
  }
  // Log the full prompt + raw response so the trace alone is enough
  // to reconstruct what the LLM saw and replied.
  await bot.log(\`  ai prompt (\${instructions.length} chars):\`);
  for (const line of instructions.split("\\n")) await bot.log(\`    | \${line}\`);
  await bot.log(\`  ai (\${elapsedMs}ms) raw=\${JSON.stringify(text)} -> \${pick}\`);
  return { pick, elapsedMs, rawText: text, prompt: instructions };
}

// Safety net: if the LLM's chosen direction lands on a close wall
// according to the engine's raycasts, override it. The veto returns
// either the original pick (no change) or a replacement that points
// at the deepest open ray; logging shows which case fired.
function vetoTurn(pick, state) {
  const offset = RELATIVE_TURNS[pick] ?? 0;
  const rays = state.raycasts || [];
  if (rays.length === 0) return { pick, vetoed: false };
  // Forward-cone rays only; BACK is never vetoed (we trust the LLM
  // on "turn around" because the engine's forward rays say nothing
  // about what's behind the player).
  if (pick === "BACK") return { pick, vetoed: false };

  const sample = predictRayAt(rays, offset);
  if (!sample) return { pick, vetoed: false };
  // The "blocked" threshold is generous on purpose — we only veto
  // when the engine is very confident the chosen lane is unwalkable.
  if (sample.hit !== "wall" || sample.distance >= 40) {
    return { pick, vetoed: false, sample };
  }

  // Pick the deepest open ray (any non-wall, or wall with > 100
  // distance) and translate its bearing back into a label.
  let best = rays[0];
  for (const r of rays) if (r.distance > best.distance) best = r;
  let replacement = "AHEAD";
  const b = best.bearing_deg;
  if (b >= 67) replacement = "HARD_LEFT";
  else if (b >= 22) replacement = "SOFT_LEFT";
  else if (b <= -67) replacement = "HARD_RIGHT";
  else if (b <= -22) replacement = "SOFT_RIGHT";
  // If the deepest open ray is *also* close, fall back to BACK.
  if (best.hit === "wall" && best.distance < 40) replacement = "BACK";
  return {
    pick: replacement,
    vetoed: true,
    sample,
    reason: \`ray at \${offset}° is \${sample.hit}@\${sample.distance.toFixed(0)}; deepest ray = \${b.toFixed(0)}°@\${best.distance.toFixed(0)} (\${best.hit})\`,
  };
}

// Convert a player-relative turn label into an absolute target world
// bearing using the player's current facing.
function turnToTargetBearing(turn, player) {
  if (!player) return null;
  const offset = RELATIVE_TURNS[turn] ?? 0;
  // \`offset\` is in Doom's CCW-positive convention (LEFT = +45°).
  return normalizeAngle(player.angle_deg + offset);
}

// Scale turn-tap duration with the absolute heading error so big
// macro errors don't take 20 ticks to close.
function turnHoldFor(errDeg) {
  const abs = Math.min(180, Math.abs(errDeg));
  // Linear: TURN_HOLD_MIN_MS at 18° (tolerance), TURN_HOLD_MAX_MS at 90°+.
  const t = Math.min(1, Math.max(0, (abs - TURN_TOLERANCE_DEG) / (90 - TURN_TOLERANCE_DEG)));
  return Math.round(TURN_HOLD_MIN_MS + t * (TURN_HOLD_MAX_MS - TURN_HOLD_MIN_MS));
}

// Doom's "use" is a toggle on doors — every press flips the door's
// open/close state. Hammering use@30ms every tick means we keep
// closing the door we just opened. Block consecutive use presses
// for this many ticks so the engine has time to animate the door.
const USE_COOLDOWN_TICKS = 8;
let _useCooldown = 0;

// Deterministic one-tick policy. Combat / doors preempt steering.
// Wall avoidance is biased toward the macro target side. The caller
// hands us a stuck counter (derived from position delta — see the
// STUCK_POS_EPS note above) and an \`actuallyMoving\` flag so we can
// distinguish "engine says mom=0 but we just teleported 60 units" from
// "engine says mom=0 and we genuinely haven't moved".
// Returns a short string describing which branch fired, so the caller
// can log it for offline analysis ("why did the bot do X on tick Y?").
async function microTick(state, targetBearing, stuckTicks, actuallyMoving) {
  if (_useCooldown > 0) _useCooldown -= 1;
  if (state.screen !== "playing") {
    await bot.press("enter");
    return \`menu(enter) screen=\${state.screen}\`;
  }

  // 1. Combat: shoot centred enemies, turn toward off-centre ones.
  const enemies = state.enemies_visible || [];
  const centred = enemies.find((e) => e.bearing === "center");
  if (centred) {
    await bot.press("fire", 200);
    return \`fire @\${centred.type}\`;
  }
  const turnTowardEnemy = enemies.find((e) => e.bearing === "left" || e.bearing === "far_left")
    ? "left"
    : enemies.find((e) => e.bearing === "right" || e.bearing === "far_right")
    ? "right"
    : null;
  if (turnTowardEnemy) {
    await bot.press(turnTowardEnemy, 120);
    return \`face-enemy \${turnTowardEnemy}\`;
  }

  // 2. Doors / switches close ahead -> activate and step through.
  //    Two guards before pressing \`use\`:
  //      a. the door must be near-centred in the FOV (otherwise we're
  //         not actually facing it; let steering align us first).
  //      b. respect a cooldown — \`use\` toggles the door, so spamming
  //         it every tick keeps re-closing what we just opened.
  const rays = state.raycasts || [];
  const fwd = rays.find((r) => Math.abs(r.bearing_deg) < 10);
  if (
    fwd &&
    (fwd.hit === "door" || fwd.hit === "switch") &&
    fwd.distance < 80 &&
    Math.abs(fwd.bearing_deg) < 8 &&
    _useCooldown === 0
  ) {
    // Single short tap; door animation runs even while we walk
    // forward, so don't burn ticks holding the key.
    await bot.press("use", 30);
    await bot.press("up", 200);
    _useCooldown = USE_COOLDOWN_TICKS;
    return \`use \${fwd.hit}@\${fwd.distance.toFixed(0)} (cooldown=\${USE_COOLDOWN_TICKS})\`;
  }

  // 3. Pinned: every nearby forward ray is a close wall. Pure rotation
  //    won't help — the player needs to physically retreat first. This
  //    catches the "wedged in a corner" case where the unstick turn
  //    below would just spin in place.
  const fwdRays = (rays || []).filter((r) => Math.abs(r.bearing_deg) < 45);
  const pinned =
    fwdRays.length > 0 &&
    fwdRays.every((r) => r.hit === "wall" && r.distance < 32);
  if (pinned) {
    await bot.press("down", 350);
    return \`pinned: back up (rays=\${fwdRays.map((r) => r.distance.toFixed(0)).join(",")})\`;
  }

  // 4. Stuck (no momentum for several ticks) -> escape: back up
  //    *then* turn. Backing up reliably breaks contact with whatever
  //    geometry we wedged into; the turn happens on the next tick.
  if (stuckTicks >= STUCK_TICKS) {
    await bot.press("down", 250);
    await bot.press("right", 250);
    return \`unstick (stuck=\${stuckTicks})\`;
  }

  // 5. Wall in our face -> turn toward the deepest open ray, but
  //    *prefer* the side closer to the macro target when both sides
  //    are roughly equal.
  if (fwd && fwd.hit === "wall" && fwd.distance < 48) {
    const targetErr =
      targetBearing !== null && state.player
        ? angleDelta(targetBearing, state.player.angle_deg)
        : 0;
    let best = rays[0];
    for (const r of rays) if (r.distance > best.distance) best = r;
    // If the macro target is more than 45° off, override the
    // deepest-ray pick with the target side; it's better to grind a
    // tic and turn correctly than walk away from where we want to go.
    const targetBiased = Math.abs(targetErr) > 45;
    const dir = targetBiased
      ? targetErr > 0
        ? "left"
        : "right"
      : best.bearing_deg < 0
      ? "left"
      : "right";
    await bot.press(dir, 220);
    return \`wall@\${fwd.distance.toFixed(0)} turn \${dir} (\${targetBiased ? "target-bias" : \`deep-ray@\${best.bearing_deg.toFixed(0)}\`})\`;
  }

  // 6. Closed-loop steering toward the macro target bearing.
  if (targetBearing !== null && state.player) {
    const err = angleDelta(targetBearing, state.player.angle_deg);
    if (Math.abs(err) > TURN_TOLERANCE_DEG) {
      // Doom's angles: +y is 90°, -y is 270°. A positive \`err\` means
      // we need to rotate counter-clockwise, which is the \`left\` key.
      const hold = turnHoldFor(err);
      const dir = err > 0 ? "left" : "right";
      await bot.press(dir, hold);
      return \`steer \${dir} \${hold}ms (err=\${err.toFixed(0)}°)\`;
    }
  }

  // 7. Heading is good (or no target): walk forward — unless we're
  //    *already* stationary with a wall in range. The default wall-
  //    avoid branch above only fires at distance<48, but a player
  //    facing wall@80 with no actual position progress will sit there
  //    pressing "up" against geometry forever. Escalate to a sideways
  //    turn. We use \`actuallyMoving\` (position-delta based) here
  //    rather than mom, because mom lags behind the engine.
  const fwdRay = fwd; // alias for clarity
  if (
    !actuallyMoving &&
    stuckTicks >= 1 &&
    fwdRay &&
    fwdRay.hit === "wall" &&
    fwdRay.distance < 120
  ) {
    // Pick the deepest open ray and turn that way; same as branch 5
    // but triggered earlier because spd=0 + close-ish wall is a
    // strong "the engine won't let me through" signal.
    let best = rays[0];
    for (const r of rays) if (r.distance > best.distance) best = r;
    const dir = best.bearing_deg < 0 ? "left" : "right";
    await bot.press(dir, 220);
    return \`stalled@wall\${fwdRay.distance.toFixed(0)} turn \${dir} (deep-ray@\${best.bearing_deg.toFixed(0)}@\${best.distance.toFixed(0)})\`;
  }

  await bot.press("up", 250);
  return targetBearing === null ? "fwd (no target)" : "fwd (on-bearing)";
}

// History of recent macro outcomes; fed back to the LLM so it can
// recognise it was pinned and pick a different direction next time.
// Keep the last 3 entries to avoid bloating the prompt.
const history = { recent: [] };

for (let macro = 0; macro < STEPS; macro++) {
  let s = await bot.getState();
  await bot.log("macro", macro, "screen:", s.screen, "hp:", s.hud.health,
    "pose:", s.player ? \`(\${s.player.x.toFixed(0)},\${s.player.y.toFixed(0)})@\${s.player.angle_deg.toFixed(0)}° (\${compassLabel(s.player.angle_deg)})\` : "?");

  if (s.screen !== "playing" && s.screen !== "automap") {
    await bot.press("enter");
    await bot.sleep(200);
    continue;
  }

  // --- ONE LLM consult per macro step: image + state digest. ---
  const shot = await snapAutomap(s.screen);
  // Surface the automap to the UI's debug-image panel so a human
  // watching the run can see exactly what the LLM saw.
  await bot.logImage(shot, \`macro \${macro} automap (pose \${s.player ? \`(\${s.player.x.toFixed(0)},\${s.player.y.toFixed(0)})@\${s.player.angle_deg.toFixed(0)}°\` : "?"})\`);
  const llmResult = await askMacroTurn(s, shot, history);
  let turn = llmResult.pick;

  // Safety net: if the LLM picked a direction the raycasts say is a
  // close wall, override. Logs both versions so we can tell whether
  // the veto fires too aggressively.
  const veto = vetoTurn(turn, s);
  if (veto.vetoed) {
    await bot.log(\`  veto: \${llmResult.pick} -> \${veto.pick} (\${veto.reason})\`);
    turn = veto.pick;
  } else if (veto.sample) {
    await bot.log(
      \`  veto: kept \${llmResult.pick} (ray@\${(RELATIVE_TURNS[llmResult.pick] ?? 0)}° = \${veto.sample.hit}@\${veto.sample.distance.toFixed(0)})\`,
    );
  }

  const targetBearing = turnToTargetBearing(turn, s.player);
  await bot.log(
    "macro turn:", turn,
    targetBearing === null
      ? "(no player pose)"
      : \`-> target bearing \${targetBearing.toFixed(0)}° (\${compassLabel(targetBearing)}) from facing \${s.player ? s.player.angle_deg.toFixed(0) : "?"}° (\${s.player ? compassLabel(s.player.angle_deg) : "?"})\`,
  );

  // --- Closed-loop micro ticks: check state, correct heading. ---
  let stuckTicks = 0;
  const startPose = s.player ? { x: s.player.x, y: s.player.y } : null;
  // Last observed pose, used to compute position delta tick-to-tick.
  // Position is the ground-truth movement signal (mom is laggy).
  let lastPos = s.player ? { x: s.player.x, y: s.player.y } : null;
  const branchCounts = {};
  for (let t = 0; t < TICKS_PER_MACRO; t++) {
    s = await bot.getState();
    if (s.screen === "dead" || s.screen === "finale") {
      await bot.log("ending screen reached:", s.screen);
      return \`ended on \${s.screen} after \${macro} macro steps\`;
    }
    // Position delta since last get_state. This is what we actually
    // trust for "are we moving?" — mom lags 1-2 engine tics behind
    // press_key, but x/y are sampled the same tic they're read.
    const posDelta =
      s.player && lastPos
        ? Math.hypot(s.player.x - lastPos.x, s.player.y - lastPos.y)
        : 0;
    const actuallyMoving = posDelta >= STUCK_POS_EPS;
    stuckTicks = actuallyMoving ? 0 : stuckTicks + 1;
    if (s.player) lastPos = { x: s.player.x, y: s.player.y };
    // Engine-reported speed kept for the log (and the LLM digest)
    // even though we no longer decide stuck-ness from it.
    const speed = s.player
      ? Math.abs(s.player.momx) + Math.abs(s.player.momy)
      : 1;

    const err =
      targetBearing !== null && s.player
        ? angleDelta(targetBearing, s.player.angle_deg)
        : 0;

    // Forward raycast distance / hit kind: lets us see *why* the
    // wall-avoid branch fires when reading the trace afterwards.
    const rays = s.raycasts || [];
    const fwd = rays.find((r) => Math.abs(r.bearing_deg) < 10);
    const fwdStr = fwd ? \`\${fwd.hit}@\${fwd.distance.toFixed(0)}\` : "(none)";
    const enemiesStr =
      (s.enemies_visible || []).length === 0
        ? "0"
        : (s.enemies_visible || [])
            .map((e) => \`\${e.type}/\${e.bearing}\`)
            .join(",");

    const branch = await microTick(s, targetBearing, stuckTicks, actuallyMoving);
    branchCounts[branch.split(" ")[0]] = (branchCounts[branch.split(" ")[0]] || 0) + 1;

    // Log both posDelta (truth) and mom (laggy) so the trace makes
    // the lag visible: you'll often see early ticks with mom=0
    // but pdΔ>0 right after a press.
    await bot.log(
      \`  t=\${String(t).padStart(2, "0")} \` +
        \`pos=(\${s.player ? s.player.x.toFixed(0) : "?"},\${s.player ? s.player.y.toFixed(0) : "?"}) \` +
        \`pdΔ=\${posDelta.toFixed(1)} \` +
        \`ang=\${s.player ? s.player.angle_deg.toFixed(0) : "?"}° err=\${err.toFixed(0)}° \` +
        \`mom=(\${s.player ? s.player.momx.toFixed(1) : "?"},\${s.player ? s.player.momy.toFixed(1) : "?"}) \` +
        \`spd=\${speed.toFixed(1)} stuck=\${stuckTicks} \` +
        \`fwd=\${fwdStr} enemies=\${enemiesStr} hp=\${s.hud.health} \` +
        \`-> \${branch}\`,
    );

    // Reset the counter right after we kicked an unstick so we don't
    // chain unstick branches forever.
    if (stuckTicks >= STUCK_TICKS) stuckTicks = 0;
    await bot.sleep(TICK_MS - 80);
  }

  // Per-macro summary: how far did we actually move, and which
  // branches dominated? Also fed back into \`history\` so the next
  // LLM consult knows whether we got stuck.
  if (s.player && startPose) {
    const dx = s.player.x - startPose.x;
    const dy = s.player.y - startPose.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const branchStr = Object.entries(branchCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => \`\${k}=\${v}\`)
      .join(" ");
    const pinned = dist < 32 ||
      (branchCounts["pinned:"] || 0) + (branchCounts["unstick"] || 0) > 6;
    await bot.log(
      \`  macro \${macro} summary: moved \${dist.toFixed(0)} units, branches: \${branchStr}\${pinned ? " [PINNED]" : ""}\`,
    );
    history.recent.push({ macro, turn, dist, pinned });
    if (history.recent.length > 3) history.recent.shift();
  }
}

return \`finished \${STEPS} macro steps\`;
`;

interface Example {
	id: string;
	label: string;
	code: string;
}

const EXAMPLES: Example[] = [
	{ id: "autoplay", label: "Autoplay: clear a level", code: AUTOPLAY_BOT },
	{ id: "simple", label: "Simple: walk forward", code: SIMPLE_BOT },
	{ id: "combat", label: "Combat: shoot + advance", code: COMBAT_BOT },
	{ id: "inspect", label: "Inspect: dump state", code: INSPECT_BOT },
	{ id: "ai-nav", label: "AI: vision-guided navigation", code: AI_NAV_BOT },
];

const STARTER_CODE = AUTOPLAY_BOT;
const STORAGE_KEY = "doom-player-bot-code";
// `sessionStorage` (per-tab) rather than `localStorage` because BR
// sessions are scoped to a single user "play session"; carrying one
// across tabs / restarts would just dump us on a dead session every
// time. Cleared on tab close, restored on reload.
const SESSION_KEY = "doom-player-br-session-id";
// Max number of bot.logImage entries kept in the side panel.
const IMAGE_HISTORY = 4;

type Mode = "idle" | "running";

/**
 * Returns true when two BR DevTools URLs point at the same browser
 * session + page target. The host's `/json/list` re-issues the JWT
 * (and any other auth query params) on every call, so we ignore
 * everything except the `/browser/<sessionId>/page/<targetId>` path
 * segment.
 */
function sameDevtoolsTarget(
	a: string | null,
	b: string | null,
): boolean {
	if (!a || !b) return false;
	const extract = (s: string): string | null => {
		const m = s.match(/\/browser\/([^/]+)\/page\/([^/?#]+)/);
		return m ? `${m[1]}/${m[2]}` : null;
	};
	const ka = extract(a);
	const kb = extract(b);
	return ka !== null && ka === kb;
}

export function App() {
	const [code, setCode] = useState<string>(() => {
		try {
			return localStorage.getItem(STORAGE_KEY) ?? STARTER_CODE;
		} catch {
			return STARTER_CODE;
		}
	});
	const [log, setLog] = useState<string[]>([]);
	// Debug images surfaced by \`bot.logImage(...)\`. We keep the most
	// recent IMAGE_HISTORY entries in display order (oldest first) so
	// the user can scroll back a few frames; older ones drop off.
	// Cleared on each new run.
	const [images, setImages] = useState<
		Array<{ mimeType: string; data: string; caption: string; receivedAt: number }>
	>([]);
	// User can collapse the image sidebar to give the log full width.
	const [imagePanelCollapsed, setImagePanelCollapsed] = useState(false);
	const [mode, setMode] = useState<Mode>("idle");
	const [devtoolsUrl, setDevtoolsUrl] = useState<string | null>(null);
	// Embed the DevTools pane by default; bot logs stay accessible via
	// the "Show log" toggle. Each fresh run flips this back on so a
	// reused browser session re-shows the inspector.
	const [showDevtools, setShowDevtools] = useState<boolean>(true);
	// BR session id captured from the previous run's `# session:`
	// marker. Sent back on the next /run so the worker reuses the
	// same Chromium instance. Persisted in sessionStorage so it
	// survives reloads of this tab.
	const [sessionId, setSessionId] = useState<string | null>(() => {
		try {
			return sessionStorage.getItem(SESSION_KEY);
		} catch {
			return null;
		}
	});
	const abortRef = useRef<AbortController | null>(null);
	// Mirror of sessionId for use inside async callbacks that
	// captured an older value (e.g. streamResponse closure).
	const sessionIdRef = useRef<string | null>(sessionId);
	const logPaneRef = useRef<HTMLPreElement | null>(null);

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, code);
		} catch {
			// ignore quota / disabled storage
		}
	}, [code]);

	useEffect(() => {
		sessionIdRef.current = sessionId;
		try {
			if (sessionId) sessionStorage.setItem(SESSION_KEY, sessionId);
			else sessionStorage.removeItem(SESSION_KEY);
		} catch {
			// ignore disabled storage
		}
	}, [sessionId]);

	// Auto-scroll the log pane as new lines arrive.
	useEffect(() => {
		const pane = logPaneRef.current;
		if (!pane) return;
		pane.scrollTop = pane.scrollHeight;
	}, [log]);

	const append = useCallback((line: string) => {
		setLog((prev) => {
			// Cap to 5000 lines so the DOM doesn't get unbounded.
			const next = prev.length >= 5000 ? prev.slice(-4500) : prev;
			return [...next, line];
		});
	}, []);

	// Some lines in the stream carry structured side-channel data
	// (devtools URL, BR session id, image dumps, ...). Recognise them
	// here and forward to state so the UI can capture them.
	const handleLine = useCallback((line: string) => {
		// \`bot.logImage(...)\` emits a single sentinel-prefixed line. We
		// peel it off and stash the image in state rather than appending
		// it as text; the JSON payload is base64-heavy and would just
		// clutter the log pane.
		if (line.startsWith("\u0001img:")) {
			try {
				const payload = JSON.parse(line.slice(5)) as {
					mimeType?: unknown;
					data?: unknown;
					caption?: unknown;
				};
				if (
					typeof payload.mimeType === "string" &&
					typeof payload.data === "string"
				) {
					const entry = {
						mimeType: payload.mimeType,
						data: payload.data,
						caption:
							typeof payload.caption === "string" ? payload.caption : "",
						receivedAt: Date.now(),
					};
					setImages((prev) => {
						// Cap at IMAGE_HISTORY entries; drop oldest first.
						const next = [...prev, entry];
						return next.length > IMAGE_HISTORY
							? next.slice(next.length - IMAGE_HISTORY)
							: next;
					});
					append(
						`# image: ${payload.mimeType}, ${payload.data.length} base64 chars${
							typeof payload.caption === "string" && payload.caption.length > 0
								? ` — ${payload.caption}`
								: ""
						}`,
					);
					return;
				}
			} catch {
				// fall through and treat as a plain log line
			}
		}
		const dt = line.match(/^# devtools: (.+)$/);
		if (dt) {
			const raw = dt[1].trim();
			if (raw && raw !== "(unavailable)") {
				// Force the full DevTools UI (vs the inline debugger
				// drawer that's used inside Chrome itself). `mode=tab`
				// is a query param the DevTools frontend reads on load.
				const sep = raw.includes("?") ? "&" : "?";
				const url = raw.includes("mode=") ? raw : `${raw}${sep}mode=tab`;
				// Avoid remounting the iframe when the new URL points
				// at the same browser session + page target as the
				// existing one (only the JWT differs across runs).
				// React would otherwise bump `src` and force a full
				// DevTools reload, losing any panel state the user
				// had open. Identity is `/browser/<sid>/page/<tid>`.
				setDevtoolsUrl((prev) =>
					sameDevtoolsTarget(prev, url) ? prev : url,
				);
				// Whenever a new URL arrives, flip the embed back on
				// so a re-run automatically shows the inspector again.
				setShowDevtools(true);
			}
		}
		const sess = line.match(/^# session: (.+)$/);
		if (sess) {
			const id = sess[1].trim();
			if (id) setSessionId(id);
		}
		append(line);
	}, [append]);

	const streamResponse = useCallback(
		async (resp: Response, signal: AbortSignal) => {
			if (!resp.body) {
				append(`# (server returned ${resp.status} ${resp.statusText} with no body)`);
				return;
			}
			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			try {
				for (;;) {
					if (signal.aborted) {
						await reader.cancel().catch(() => {});
						break;
					}
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const l of lines) handleLine(l);
				}
				buf += decoder.decode();
				if (buf.length > 0) handleLine(buf);
			} catch (err) {
				if (!signal.aborted) {
					append(`# stream error: ${(err as Error).message}`);
				}
			}
		},
		[append, handleLine],
	);

	const runBot = useCallback(async () => {
		if (mode === "running") return;
		setMode("running");
		setLog([]);
		setImages([]);
		const reuseId = sessionIdRef.current;
		// Only blank the embedded DevTools iframe when we're starting
		// from scratch. If we're about to reuse the same BR session,
		// the next run's `# devtools:` line will carry the same URL
		// anyway, and tearing the iframe down + remounting just
		// flashes the panel and discards any DevTools-side state
		// (open tabs, breakpoints, scroll position).
		if (!reuseId) setDevtoolsUrl(null);
		const ac = new AbortController();
		abortRef.current = ac;
		try {
			append(
				`# POST /run (${code.length} bytes)` +
					(reuseId ? ` (reusing session ${reuseId})` : ""),
			);
			const requestBody: Record<string, unknown> = { code };
			if (reuseId) requestBody.sessionId = reuseId;
			const resp = await fetch("/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(requestBody),
				signal: ac.signal,
			});
			await streamResponse(resp, ac.signal);
		} catch (err) {
			if ((err as Error).name !== "AbortError") {
				append(`# fetch error: ${(err as Error).message}`);
			}
		} finally {
			append(`# (run finished)`);
			setMode("idle");
			abortRef.current = null;
		}
	}, [append, code, mode, streamResponse]);

	const stop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const clearLog = useCallback(() => {
		setLog([]);
		setImages([]);
	}, []);
	const resetCode = useCallback(() => setCode(STARTER_CODE), []);
	const resetSession = useCallback(() => {
		setSessionId(null);
		setDevtoolsUrl(null);
	}, []);
	const loadExample = useCallback(
		(id: string) => {
			const ex = EXAMPLES.find((e) => e.id === id);
			if (!ex) return;
			// If the current buffer matches any known example exactly,
			// swap without prompting. Otherwise confirm so we don't
			// silently drop user edits.
			const isPristine = EXAMPLES.some((e) => e.code === code);
			if (!isPristine) {
				const ok = window.confirm(
					`Replace current bot code with the "${ex.label}" example?`,
				);
				if (!ok) return;
			}
			setCode(ex.code);
		},
		[code],
	);

	return (
		<div className="app">
			<header className="header">
				<h1>doom-player</h1>
				<span className="subtitle">
					Write a bot. It runs inside a codemode sandbox against the live game.
				</span>
			</header>
			<div className="grid">
				<section className="editor-pane">
					<div className="toolbar">
						<button
							type="button"
							onClick={runBot}
							disabled={mode === "running"}
							className="primary"
						>
							{mode === "running" ? "Running…" : "Run bot"}
						</button>
						<button
							type="button"
							onClick={stop}
							disabled={mode !== "running"}
						>
							Stop
						</button>
						<span className="spacer" />
						<label className="example-picker">
							<span>Examples:</span>
							<select
								value=""
								onChange={(e) => {
									if (e.target.value) loadExample(e.target.value);
									e.target.value = "";
								}}
								disabled={mode === "running"}
							>
								<option value="" disabled>
									Load…
								</option>
								{EXAMPLES.map((ex) => (
									<option key={ex.id} value={ex.id}>
										{ex.label}
									</option>
								))}
							</select>
						</label>
						{sessionId ? (
							<span
								className="session-chip"
								title={`Will reuse BR session ${sessionId} on next run`}
							>
								session {sessionId.slice(0, 8)}
								<button
									type="button"
									className="session-reset"
									onClick={resetSession}
									disabled={mode === "running"}
									title="Drop the saved session id; next run will allocate a fresh browser"
								>
									×
								</button>
							</span>
						) : null}
						<button type="button" onClick={resetCode} title="Reset to starter snippet">
							Reset
						</button>
					</div>
					<div className="editor-wrapper">
						<CodeMirror
							value={code}
							height="100%"
							maxHeight="100%"
							theme="dark"
							extensions={[javascript({ jsx: false, typescript: false })]}
							onChange={(v) => setCode(v)}
							basicSetup={{
								lineNumbers: true,
								highlightActiveLine: true,
								foldGutter: true,
								indentOnInput: true,
								bracketMatching: true,
								closeBrackets: true,
							}}
						/>
					</div>
				</section>
				<section className="log-pane">
					<div className="toolbar">
						<span className="log-title">
							{showDevtools
								? `Browser DevTools + log (${log.length} lines)`
								: `Live log (${log.length} lines)`}
						</span>
						<span className="spacer" />
						{devtoolsUrl ? (
							<>
								<a
									href={devtoolsUrl}
									target="_blank"
									rel="noreferrer noopener"
									className="link-button"
									title="Open the headless browser's DevTools in a new tab"
								>
									Open DevTools ↗
								</a>
								<button
									type="button"
									onClick={() => setShowDevtools((v) => !v)}
									title="Embed the DevTools frontend in this pane"
								>
									{showDevtools ? "Hide DevTools" : "Embed DevTools"}
								</button>
							</>
						) : null}
						{images.length > 0 ? (
							<button
								type="button"
								onClick={() => setImagePanelCollapsed((v) => !v)}
								title="Collapse / expand the bot.logImage panel"
							>
								{imagePanelCollapsed
									? `Show images (${images.length})`
									: "Hide images"}
							</button>
						) : null}
						<button
							type="button"
							onClick={clearLog}
							disabled={log.length === 0}
						>
							Clear
						</button>
					</div>
					{/* Two-column layout: log/DevTools on the left, debug-image
					    side panel on the right. The image panel only renders
					    when an image has been received AND the user hasn't
					    collapsed it. Collapsing leaves a thin gutter with an
					    expand button so the panel can be brought back. */}
					<div className="log-with-image">
						<div className="log-main">
							{showDevtools && devtoolsUrl ? (
								// Split layout: DevTools on top, live log below. The
								// log strip is fixed-height so users can still scan
								// streamed output (preroll progress, bot.log lines,
								// errors) without leaving the DevTools view.
								<div className="split-pane">
									<iframe
										className="devtools-iframe"
										src={devtoolsUrl}
										title="Browser DevTools"
										// allow-same-origin is required for DevTools'
										// own UI to bootstrap; the inner page is
										// already on a different origin.
										sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
									/>
									<div className="split-divider" aria-hidden="true" />
									<pre ref={logPaneRef} className="log log-strip">
										{log.length === 0 ? (
											<span className="placeholder">
												Output streams here. Click <strong>Run bot</strong> to start.
											</span>
										) : (
											log.join("\n")
										)}
									</pre>
								</div>
							) : (
								<pre ref={logPaneRef} className="log">
									{log.length === 0 ? (
										<span className="placeholder">
											Output streams here. Click <strong>Run bot</strong> to start.
										</span>
									) : (
										log.join("\n")
									)}
								</pre>
							)}
						</div>
						{images.length > 0 && !imagePanelCollapsed ? (
							<aside className="debug-image-side">
								<div className="debug-image-header">
									<span className="debug-image-title">
										images ({images.length}/{IMAGE_HISTORY})
									</span>
									<button
										type="button"
										className="debug-image-collapse"
										onClick={() => setImagePanelCollapsed(true)}
										title="Collapse image panel"
									>
										×
									</button>
								</div>
								{/* Newest image at the top so the most recent is
								    always visible without scrolling. */}
								{[...images].reverse().map((img) => (
									<div
										key={img.receivedAt}
										className="debug-image-entry"
									>
										<img
											src={`data:${img.mimeType};base64,${img.data}`}
											alt={img.caption || "bot.logImage"}
											className="debug-image-img"
										/>
										{img.caption ? (
											<div className="debug-image-caption">{img.caption}</div>
										) : null}
									</div>
								))}
							</aside>
						) : null}
					</div>
				</section>
			</div>
		</div>
	);
}
