// Deterministic Doom auto-player.
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
