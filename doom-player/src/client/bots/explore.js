// Memory-based exploration: paint what raycasts see, head where you
// haven't been. No LLM — the engine's raycasts + position are enough.
//
// Memory canvas: a single high-resolution pixel buffer that lives for
// the whole run. World units -> pixels via SCALE = 8 (so 1 pixel == 8
// map units). At 800x800 pixels that covers a 6400x6400 unit area —
// generous for Doom 1 / 2 level extents. Doom doesn't expose level
// bounds via get_state (see AM_findMinMaxBoundaries in am_map.c) so we
// pre-size and centre on the player's first observed position.
//
// Each tick we update three things:
//   1. The 8 visibility rays the engine reports. Cells the ray passed
//      through -> FLOOR; the hit cell -> WALL / DOOR / SWITCH / EXIT /
//      THING. Higher-rank observations never get overwritten.
//   2. Visible things (pickups, decor, enemies, barrels): painted at
//      their world position and tracked in a sticky map. If a tracked
//      thing close to the player disappears from things_visible we
//      assume the player just picked it up (or shot it) and clear
//      the pixel back to FLOOR.
//   3. The player's own cell, stamped PLAYER.
//
// Direction picking divides the world around the player into 8
// octants and picks the one whose lookahead area is least-explored,
// penalising octants that are mostly wall.
//
// Debug dump: instead of sending the whole 800x800 canvas (huge PNG,
// hard to scan), we clip a small window centred on the player and
// log THAT. The crop is sized so 1 source pixel == 1 output pixel
// (no scaling) — keeps detail crisp in the side panel.

const SCALE = 8;                 // map units per memory pixel
const SIZE  = 800;               // memory canvas edge, in pixels
const CENTRE = SIZE / 2;

const CROP = 256;                // edge of the clipped debug view
const CROP_HALF = CROP / 2;

const STEPS = 6;
const TICKS_PER_MACRO = 12;
const TICK_PAUSE_MS = 25;
const LOG_EVERY = 2;             // log clipped view every N macros
const TURN_TOLERANCE_DEG = 15;
const DEBUG_TICKS = true;

// Distance under which a previously-seen thing that has fallen out
// of things_visible is presumed picked up (in map units).
const PICKUP_RADIUS = 96;

const INTEREST_PRIORITY = {
  exit: 0,
  switch: 1,
  door: 2,
  key: 3,
};

const OPPORTUNISTIC_PICKUPS = new Set(["weapon", "powerup", "armor", "health", "ammo"]);

// Palette (RGBA bytes). UNSEEN must stay all-zero R/G/B so an
// initially-zero buffer reads as "unexplored" without painting it.
const COL = {
  UNSEEN:  [  0,   0,   0, 255],
  FLOOR:   [ 40,  40,  40, 255],
  VISITED: [  0,  90, 180, 255],
  RAY:     [ 60,  60, 100, 255],
  WALL:    [220, 220, 220, 255],
  DOOR:    [240, 200,  40, 255],
  SWITCH:  [  0, 200, 200, 255],
  EXIT:    [ 80, 240,  80, 255],
  THING:   [220,  60, 220, 255],
  ENEMY:   [255, 120,  40, 255],
  PLAYER:  [255,  60,  60, 255],
};

const RANK = {
  UNSEEN: -1, FLOOR: 0, RAY: 1, VISITED: 2, PLAYER: 3, THING: 4, ENEMY: 5,
  SWITCH: 6, DOOR: 7, EXIT: 8, WALL: 9,
};

// Memory canvas. RGB starts at 0 (UNSEEN); alpha must be 255 so the
// PNG renders opaque. One byte of rank per pixel runs alongside so
// observations can never downgrade.
const mem = new Uint8Array(SIZE * SIZE * 4);
for (let i = 0; i < SIZE * SIZE; i++) mem[i * 4 + 3] = 255;
const rank = new Int8Array(SIZE * SIZE);
rank.fill(RANK.UNSEEN);

// Sticky thing tracker, keyed by quantised world position. Each
// entry stores { x, y, category, lastSeenMacro, lastSeenTick }.
// We use a Map so deletions are O(1) when the player picks
// something up.
const things = new Map();
const thingKey = (wx, wy) => Math.round(wx / 8) + "," + Math.round(wy / 8);

let originX = null;
let originY = null;

function paint(px, py, name) {
  if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return;
  const idx = py * SIZE + px;
  if (rank[idx] >= RANK[name]) return;
  rank[idx] = RANK[name];
  const col = COL[name];
  const o = idx * 4;
  mem[o] = col[0]; mem[o + 1] = col[1]; mem[o + 2] = col[2]; mem[o + 3] = col[3];
}

// Force-paint regardless of rank — used when an item is picked up so
// THING/ENEMY pixels revert to FLOOR.
function repaint(px, py, name) {
  if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return;
  const idx = py * SIZE + px;
  rank[idx] = RANK[name];
  const col = COL[name];
  const o = idx * 4;
  mem[o] = col[0]; mem[o + 1] = col[1]; mem[o + 2] = col[2]; mem[o + 3] = col[3];
}

function worldToPx(wx, wy) {
  return {
    px: Math.round(CENTRE + (wx - originX) / SCALE),
    py: Math.round(CENTRE - (wy - originY) / SCALE),
  };
}

function paintRay(playerX, playerY, worldBearingDeg, distance, hitKind) {
  const rad = (worldBearingDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const stepUnits = SCALE; // 1 pixel per step now
  const steps = Math.max(1, Math.floor(distance / stepUnits));
  for (let s = 1; s < steps; s++) {
    const p = worldToPx(playerX + dx * s * stepUnits, playerY + dy * s * stepUnits);
    paint(p.px, p.py, "FLOOR");
  }
  const hp = worldToPx(playerX + dx * distance, playerY + dy * distance);
  const name = hitKind === "door" ? "DOOR"
            : hitKind === "switch" ? "SWITCH"
            : hitKind === "exit" ? "EXIT"
            : hitKind === "thing" ? "THING"
            : hitKind === "open" ? "FLOOR"
            : "WALL";
  paint(hp.px, hp.py, name);
}

// Convert a "thing" sighting (bearing+distance) into a world position
// and record it in the sticky tracker.
function recordThing(state, t, macro, tick) {
  const p = state.player;
  if (!p) return;
  const worldBearing = p.angle_deg - t.bearing_deg;
  const rad = (worldBearing * Math.PI) / 180;
  const wx = p.x + Math.cos(rad) * t.distance;
  const wy = p.y + Math.sin(rad) * t.distance;
  const key = thingKey(wx, wy);
  const cat = t.category || "thing";
  const colName = cat === "enemy" || cat === "barrel" ? "ENEMY" : "THING";
  things.set(key, { x: wx, y: wy, category: cat, colName, lastSeenMacro: macro, lastSeenTick: tick });
  const px = worldToPx(wx, wy);
  paint(px.px, px.py, colName);
}

// If a tracked thing is very close to the player and we DIDN'T see
// it this tick, assume the player picked it up (or killed it) and
// erase the pixel back to FLOOR. Avoids stale magenta dots dotting
// the memory map after the player walked through.
function sweepPickups(state, currentlyVisibleKeys) {
  const p = state.player;
  if (!p) return 0;
  let removed = 0;
  for (const [key, t] of things) {
    if (currentlyVisibleKeys.has(key)) continue;
    const d = Math.hypot(p.x - t.x, p.y - t.y);
    if (d > PICKUP_RADIUS) continue;
    // Out of sight + within pickup range == gone.
    const px = worldToPx(t.x, t.y);
    repaint(px.px, px.py, "FLOOR");
    things.delete(key);
    removed++;
  }
  return removed;
}

function recordObservation(state, macro, tick) {
  const p = state.player;
  if (!p) return;
  if (originX === null) { originX = p.x; originY = p.y; }

  // Rays first so floor coverage is laid down before things stamp
  // over it.
  for (const r of (state.raycasts || [])) {
    const worldBearing = p.angle_deg - r.bearing_deg;
    paintRay(p.x, p.y, worldBearing, r.distance, r.hit);
  }

  // Things: mark visible ones AND sweep ones we just walked through.
  const visibleKeys = new Set();
  for (const t of (state.things_visible || [])) {
    const worldBearing = p.angle_deg - t.bearing_deg;
    const rad = (worldBearing * Math.PI) / 180;
    const wx = p.x + Math.cos(rad) * t.distance;
    const wy = p.y + Math.sin(rad) * t.distance;
    visibleKeys.add(thingKey(wx, wy));
    recordThing(state, t, macro, tick);
  }
  sweepPickups(state, visibleKeys);

  // Player cell + a small cross stamp for visibility.
  const me = worldToPx(p.x, p.y);
  paint(me.px - 1, me.py, "VISITED");
  paint(me.px + 1, me.py, "VISITED");
  paint(me.px, me.py - 1, "VISITED");
  paint(me.px, me.py + 1, "VISITED");
  paint(me.px, me.py, "PLAYER");
}

function angleDelta(a, c) {
  let d = (a - c) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function normAngle(a) {
  return ((a % 360) + 360) % 360;
}

function thingPriority(t) {
  const cat = t.category || "thing";
  if (!(cat in INTEREST_PRIORITY)) return null;
  return INTEREST_PRIORITY[cat];
}

function opportunisticPickupScore(t) {
  const cat = t.category || "thing";
  if (!OPPORTUNISTIC_PICKUPS.has(cat)) return null;
  const distance = typeof t.distance === "number" ? t.distance : 9999;
  const bearing = typeof t.bearing_deg === "number" ? t.bearing_deg : 999;
  // Explore mode should not chase side pickups. Only grab things we
  // are already about to walk through.
  if (distance > 160 || Math.abs(bearing) > 18) return null;
  return 20 + distance / 32;
}

function pickInterestingTarget(state, failedTargets, macro) {
  const p = state.player;
  if (!p) return null;
  for (const [key, expires] of failedTargets) {
    if (expires <= macro) failedTargets.delete(key);
  }
  const candidates = [];
  for (const t of (state.things_visible || [])) {
    let pri = thingPriority(t);
    if (pri === null) pri = opportunisticPickupScore(t);
    if (pri === null) continue;
    const cat = t.category || "thing";
    const distance = typeof t.distance === "number" ? t.distance : 9999;
    if (distance > 640) continue;
    const worldBearing = p.angle_deg - t.bearing_deg;
    const rad = (worldBearing * Math.PI) / 180;
    const tx = p.x + Math.cos(rad) * distance;
    const ty = p.y + Math.sin(rad) * distance;
    const targetKey = "thing:" + cat + ":" + (t.type || "thing") + ":" + Math.round(tx / 64) + "," + Math.round(ty / 64);
    if (failedTargets.has(targetKey)) continue;
    candidates.push({
      kind: cat,
      type: t.type || "thing",
      bearing: normAngle(worldBearing),
      distance,
      priority: pri,
      targetKey,
    });
  }
  for (const r of (state.raycasts || [])) {
    if (!(r.hit in INTEREST_PRIORITY)) continue;
    if (r.distance > 640) continue;
    const targetKey = "special:" + r.hit + ":" + Math.round((p.angle_deg - r.bearing_deg) / 15) + ":" + Math.round(r.distance / 64);
    if (failedTargets.has(targetKey)) continue;
    candidates.push({
      kind: r.hit,
      type: r.thing_type || r.hit,
      bearing: normAngle(p.angle_deg - r.bearing_deg),
      distance: r.distance,
      priority: INTEREST_PRIORITY[r.hit],
      targetKey,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.distance - b.distance;
  });
  return candidates[0];
}

// Probe a circular patch in the memory canvas and return how
// "covered" it is (FLOOR/VISITED/...) plus a wallHits count.
function probePatch(cx, cy, R) {
  let explored = 0;
  let total = 0;
  let wallHits = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      total++;
      const r = rank[y * SIZE + x];
      if (r >= RANK.FLOOR) explored++;
      if (r === RANK.WALL) wallHits++;
    }
  }
  return { explored, total, wallHits, ratio: total > 0 ? explored / total : 1 };
}

// Pick the best octant to head toward. We score with two concentric
// probes: a close ring (just past the painted area) where the player
// has actually observed pixels, and a far ring for "is there room to
// keep going?". Close ring is weighted more so genuinely-explored
// directions look "covered" even before the far ring is filled in.
//
// `history` is a list of the last few { bearing, dist } macro
// outcomes. Recent picks that produced no movement are excluded from
// the candidate set entirely so we don't pick them again. If every
// candidate would be excluded we fall back to a hard turn 90° away
// from the most recent failed direction.
function pickLeastExploredOctant(state, history) {
  const p = state.player;
  if (!p) return null;
  const me = worldToPx(p.x, p.y);

  // Two probe rings. Close radius sits at the edge of what raycasts
  // (max ~1024 units / 128 px) will have painted; far is the
  // "lookahead" the previous version used.
  const CLOSE_RADIUS_PX = 20;   // ~160 world units
  const CLOSE_PROBE_R = 10;
  const FAR_RADIUS_PX = 56;     // ~448 world units
  const FAR_PROBE_R = 14;

  // Penalty bookkeeping: any bearing the bot picked in the last 2
  // macros AND moved < 64 units afterwards is "dead" -- skip it.
  const dead = new Set();
  for (const h of history) {
    if (h && h.dist < 64) dead.add(h.bearing);
  }
  const recent = history.length > 0 ? history[history.length - 1] : null;

  const candidates = [];
  for (let o = 0; o < 8; o++) {
    const bearing = o * 45;
    const rad = (bearing * Math.PI) / 180;
    const close = probePatch(
      me.px + Math.cos(rad) * CLOSE_RADIUS_PX,
      me.py - Math.sin(rad) * CLOSE_RADIUS_PX,
      CLOSE_PROBE_R,
    );
    const far = probePatch(
      me.px + Math.cos(rad) * FAR_RADIUS_PX,
      me.py - Math.sin(rad) * FAR_RADIUS_PX,
      FAR_PROBE_R,
    );
    // Combined score: close ring weighted 2x. wallHits penalty makes
    // walls "look covered" so we don't head straight into them.
    const score =
      (close.ratio * 2 + far.ratio) / 3 +
      (close.wallHits + far.wallHits * 0.5) * 0.003 +
      (recent && recent.dist < STUCK_DIST && Math.abs(angleDelta(bearing, recent.bearing)) < 90 ? 0.8 : 0);
    candidates.push({
      bearing,
      score,
      closeRatio: close.ratio,
      farRatio: far.ratio,
      wallHits: close.wallHits + far.wallHits,
      isDead: dead.has(bearing),
    });
  }

  // First try only "alive" candidates. If none, fall back to the
  // full set but force a bearing far from any dead one.
  let alive = candidates.filter((c) => !c.isDead);
  if (alive.length === 0) alive = candidates;
  alive.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Tiebreak: prefer bearings NOT close to recent failed picks.
    const recentBearing = history.length > 0 ? history[history.length - 1].bearing : null;
    if (recentBearing !== null) {
      const da = Math.abs(angleDelta(a.bearing, recentBearing));
      const db = Math.abs(angleDelta(b.bearing, recentBearing));
      if (da !== db) return db - da;
    }
    return Math.abs(angleDelta(a.bearing, p.angle_deg)) - Math.abs(angleDelta(b.bearing, p.angle_deg));
  });
  const pick = alive[0];
  pick.debugTop = alive.slice(0, 4).map((c) =>
    c.bearing + ":" + c.score.toFixed(2) + "/c" + c.closeRatio.toFixed(2) + "/f" + c.farRatio.toFixed(2) + "/w" + c.wallHits + (c.isDead ? "D" : ""),
  ).join(" ");
  return pick;
}

// Extract a CROP x CROP RGBA window centred on the player. Areas
// outside the source canvas are filled with UNSEEN (opaque black).
// We also paint a centred arrow showing the player facing so the
// orientation of the clip is unambiguous.
function clipAroundPlayer(state) {
  const p = state.player;
  if (!p) return null;
  const me = worldToPx(p.x, p.y);
  const out = new Uint8Array(CROP * CROP * 4);
  for (let i = 0; i < CROP * CROP; i++) out[i * 4 + 3] = 255;

  const sx0 = me.px - CROP_HALF;
  const sy0 = me.py - CROP_HALF;
  for (let dy = 0; dy < CROP; dy++) {
    const sy = sy0 + dy;
    if (sy < 0 || sy >= SIZE) continue;
    for (let dx = 0; dx < CROP; dx++) {
      const sx = sx0 + dx;
      if (sx < 0 || sx >= SIZE) continue;
      const si = (sy * SIZE + sx) * 4;
      const oi = (dy * CROP + dx) * 4;
      out[oi]     = mem[si];
      out[oi + 1] = mem[si + 1];
      out[oi + 2] = mem[si + 2];
      out[oi + 3] = mem[si + 3];
    }
  }

  // Player arrow in the dead centre of the crop. A short line in the
  // facing direction + a red dot on the player pixel.
  const cx = CROP_HALF;
  const cy = CROP_HALF;
  const stamp = (px, py, col) => {
    if (px < 0 || py < 0 || px >= CROP || py >= CROP) return;
    const o = (py * CROP + px) * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
  };
  const rad = (p.angle_deg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad); // screen y flips
  for (let i = 1; i <= 8; i++) {
    stamp(Math.round(cx + dx * i), Math.round(cy + dy * i), COL.PLAYER);
  }
  stamp(cx, cy, COL.PLAYER);
  stamp(cx + 1, cy, COL.PLAYER);
  stamp(cx - 1, cy, COL.PLAYER);
  stamp(cx, cy + 1, COL.PLAYER);
  stamp(cx, cy - 1, COL.PLAYER);
  return out;
}

// Closure state for stationary detection. We compare the player's
// position across consecutive micro ticks to spot "pressing up but
// not actually moving" wedges that the raycast wall-avoid can't see
// (fwd ray > 48 because it grazes past a corner).
let _lastMicroX = null;
let _lastMicroY = null;
let _stationaryTicks = 0;
let _lastMoveIntent = false;
let _wallAvoidTicks = 0;
let _avoidBearing = null;
let _avoidTicks = 0;
let _avoidStartX = null;
let _avoidStartY = null;
let _useCooldownTicks = 0;
let _postUseForwardTicks = 0;
const MICRO_MIN_DELTA = 6;   // map units of movement to count as "moving"
const MICRO_STUCK_TICKS = 3; // back-up after this many stationary ticks
const AVOID_CLEAR_DIST = 96;
const WALL_SAFE_DIST = 128;
const USE_COOLDOWN_TICKS = 8;
const POST_USE_FORWARD_TICKS = 4;

function microResult(action, moveIntent) {
  if (!action.startsWith("wall-avoid")) _wallAvoidTicks = 0;
  _lastMoveIntent = moveIntent;
  return action;
}

function isBlockingAhead(ray, distance) {
  if (!ray || ray.distance >= distance) return false;
  if (ray.hit === "wall") return true;
  if (ray.hit !== "thing") return false;
  const cat = ray.thing_category || "";
  return cat === "decor" || cat === "barrel" || cat === "enemy";
}

function bestRay(rays) {
  let best = rays[0];
  for (const r of rays) if (!best || r.distance > best.distance) best = r;
  return best;
}

function escapeBearing(player, rays, fwd) {
  const best = bestRay(rays);
  if (!player || !best) return null;
  // If the "best" ray is basically the forward ray, this is a corner/pocket.
  // Pick a hard diagonal escape instead of re-entering the same collision.
  if (Math.abs(best.bearing_deg) < 15 || (fwd && best.distance < fwd.distance + 96)) {
    return normAngle(player.angle_deg + 135);
  }
  return normAngle(player.angle_deg - best.bearing_deg);
}

async function microTick(state, target) {
  if (state.screen !== "playing") {
    await bot.press("enter");
    return microResult("menu", false);
  }
  const p = state.player;
  // Position-delta stuck detection. mom is laggy (see get_state docs)
  // so we use x/y, which are sampled the tic they're read. Reset
  // on real movement.
  if (p) {
    if (_lastMicroX !== null) {
      const dist = Math.hypot(p.x - _lastMicroX, p.y - _lastMicroY);
      _stationaryTicks = _lastMoveIntent && dist < MICRO_MIN_DELTA ? _stationaryTicks + 1 : 0;
    }
    _lastMicroX = p.x;
    _lastMicroY = p.y;
    if (_avoidStartX !== null && Math.hypot(p.x - _avoidStartX, p.y - _avoidStartY) > AVOID_CLEAR_DIST) {
      _avoidBearing = null;
      _avoidTicks = 0;
      _avoidStartX = null;
      _avoidStartY = null;
    }
  }

  const rays = state.raycasts || [];
  const fwd = rays.find((r) => Math.abs(r.bearing_deg) < 10);
  if (_useCooldownTicks > 0) _useCooldownTicks--;
  if (_postUseForwardTicks > 0) {
    _postUseForwardTicks--;
    await bot.press("up", 180);
    return microResult("post-use-fwd", true);
  }

  const enemies = state.enemies_visible || [];
  const centred = enemies.find((e) => e.bearing === "center");
  if (centred) { await bot.press("fire", 100); return microResult("fire", false); }
  const off = enemies.find((e) => e.bearing === "left" || e.bearing === "far_left") ? "left"
            : enemies.find((e) => e.bearing === "right" || e.bearing === "far_right") ? "right"
            : null;
  if (off) { await bot.press(off, 80); return microResult("face-enemy", false); }
  const effectiveTarget = _avoidTicks > 0 && _avoidBearing !== null
    ? { bearing: _avoidBearing, kind: "avoid", distance: 9999 }
    : target;
  if (_useCooldownTicks <= 0 && fwd && (fwd.hit === "door" || fwd.hit === "switch" || fwd.hit === "exit") && fwd.distance < 160 && Math.abs(fwd.bearing_deg) < 8) {
    await bot.press("use", 30);
    await bot.press("up", 120);
    _useCooldownTicks = USE_COOLDOWN_TICKS;
    _postUseForwardTicks = POST_USE_FORWARD_TICKS;
    return microResult("use", true);
  }

  // Pinned: the engine isn't letting us move regardless of which key
  // we press. Back up to break contact with whatever geometry has
  // us stuck (corner, doorframe, decoration). Reset the counter
  // afterwards so we get one clean tick to re-evaluate.
  if (_stationaryTicks >= MICRO_STUCK_TICKS) {
    const best = bestRay(rays);
    const escape = escapeBearing(p, rays, fwd);
    if (p && escape !== null) {
      _avoidBearing = escape;
      _avoidTicks = 8;
      _avoidStartX = p.x;
      _avoidStartY = p.y;
    }
    await bot.press("down", 160);
    if (p && escape !== null) {
      await bot.press(angleDelta(escape, p.angle_deg) > 0 ? "left" : "right", 220);
    } else {
      await bot.press("right", 220);
    }
    _stationaryTicks = 0;
    return microResult("unwedge:" + (best ? best.bearing_deg.toFixed(0) : "?"), true);
  }

  if (isBlockingAhead(fwd, WALL_SAFE_DIST)) {
    _wallAvoidTicks++;
    const best = bestRay(rays);
    const escape = escapeBearing(p, rays, fwd);
    if (p && escape !== null) {
      _avoidBearing = escape;
      _avoidTicks = 8;
      if (_avoidStartX === null) {
        _avoidStartX = p.x;
        _avoidStartY = p.y;
      }
    }
    if (_wallAvoidTicks >= 4) {
      await bot.press("down", 220);
      if (p && escape !== null) {
        await bot.press(angleDelta(escape, p.angle_deg) > 0 ? "left" : "right", 260);
      } else {
        await bot.press("right", 260);
      }
      return microResult("wall-escape:" + (best ? best.bearing_deg.toFixed(0) : "?"), true);
    }
    if (p && escape !== null) {
      await bot.press(angleDelta(escape, p.angle_deg) > 0 ? "left" : "right", 220);
    } else {
      await bot.press(best.bearing_deg < 0 ? "left" : "right", Math.min(260, 120 + Math.abs(best.bearing_deg) * 4));
    }
    return microResult("wall-avoid:" + (best ? best.bearing_deg.toFixed(0) : "?"), false);
  }
  if (!isBlockingAhead(fwd, WALL_SAFE_DIST) && _avoidTicks > 0) _avoidTicks--;
  if (_avoidTicks <= 0 && _avoidStartX === null) _avoidBearing = null;
  if (effectiveTarget && state.player) {
    const err = angleDelta(effectiveTarget.bearing, state.player.angle_deg);
    if (_useCooldownTicks <= 0 && (effectiveTarget.kind === "door" || effectiveTarget.kind === "switch" || effectiveTarget.kind === "exit") && effectiveTarget.distance < 180 && Math.abs(err) < 25) {
      await bot.press("use", 40);
      await bot.press("up", 120);
      _useCooldownTicks = USE_COOLDOWN_TICKS;
      _postUseForwardTicks = POST_USE_FORWARD_TICKS;
      return microResult("use-target", true);
    }
    if (Math.abs(err) > TURN_TOLERANCE_DEG) {
      const turnKey = err > 0 ? "left" : "right";
      const hold = Math.min(240, Math.max(70, Math.abs(err) * 2.6));
      await bot.press(turnKey, hold);
      if (Math.abs(err) < 60 && !isBlockingAhead(fwd, WALL_SAFE_DIST)) {
        await bot.press("up", 90);
        return microResult("steer-fwd:" + effectiveTarget.kind + ":" + turnKey + ":" + err.toFixed(0) + ":" + hold.toFixed(0), true);
      }
      return microResult("steer:" + effectiveTarget.kind + ":" + turnKey + ":" + err.toFixed(0) + ":" + hold.toFixed(0), false);
    }
  }
  if (isBlockingAhead(fwd, WALL_SAFE_DIST)) {
    await bot.press("right", 180);
    return microResult("blocked-turn", false);
  }
  await bot.press("up", 130);
  return microResult("fwd", true);
}

// Per-macro history: { bearing, dist } for the last few macros. The
// picker uses this to exclude bearings that just produced no
// movement, breaking the "same direction every macro" loop.
const history = [];
const HISTORY_LEN = 3;
const failedTargets = new Map();
// Distance below which a macro is considered "stuck".
const STUCK_DIST = 64;

for (let macro = 0; macro < STEPS; macro++) {
  let s = await bot.getState();
  if (s.screen !== "playing" && s.screen !== "automap") {
    await bot.press("enter");
    await bot.sleep(200);
    continue;
  }
  recordObservation(s, macro, 0);
  const interesting = pickInterestingTarget(s, failedTargets, macro);
  let pick = interesting || pickLeastExploredOctant(s, history);

  // Hard-stuck escape: if the last 2 macros barely moved, force a
  // bearing >= 90° off the most recent pick regardless of score.
  const stuckRun = history.slice(-2).filter((h) => h.dist < STUCK_DIST).length;
  if (stuckRun >= 2 && history.length > 0) {
    const last = history[history.length - 1].bearing;
    const forced = (last + 135) % 360; // sharp turn, not a U-turn
    pick = { bearing: forced, score: -1, closeRatio: 0, farRatio: 0, wallHits: 0, forced: true };
  }
  const target = pick ? { bearing: pick.bearing, kind: pick.kind || (pick.forced ? "forced" : "explore"), distance: pick.distance || 9999 } : null;
  const targetBearing = target ? target.bearing : null;

  const startPose = { x: s.player.x, y: s.player.y };
  const actionCounts = {};
  await bot.log(
    "macro " + macro +
    " pose=(" + s.player.x.toFixed(0) + "," + s.player.y.toFixed(0) + ")@" +
    s.player.angle_deg.toFixed(0) + "° things_tracked=" + things.size +
    " stuckRun=" + stuckRun + " " +
    (pick
      ? "-> head " + targetBearing + "°" +
        (interesting ? " [TARGET " + interesting.kind + ":" + interesting.type + " d=" + interesting.distance.toFixed(0) + "]" :
        (pick.forced ? " [FORCED 135° off last pick]" :
          " (close=" + pick.closeRatio.toFixed(2) +
          ", far=" + pick.farRatio.toFixed(2) +
          ", wallHits=" + pick.wallHits + ")"))
      : "no target"),
  );
  if (pick && pick.debugTop) await bot.log("  candidates " + pick.debugTop);
  if (target) {
    const me = worldToPx(s.player.x, s.player.y);
    await bot.log(
      "  target kind=" + target.kind + " bearing=" + target.bearing.toFixed(0) +
      " dist=" + target.distance.toFixed(0) + " playerPx=(" + me.px + "," + me.py + ")",
    );
  }

  for (let t = 0; t < TICKS_PER_MACRO; t++) {
    s = await bot.getState();
    if (s.screen === "dead" || s.screen === "finale") {
      return "ended on " + s.screen + " after " + macro + " macros";
    }
    recordObservation(s, macro, t);
    const before = s.player ? { x: s.player.x, y: s.player.y, angle: s.player.angle_deg } : null;
    const rays = s.raycasts || [];
    const fwd = rays.find((r) => Math.abs(r.bearing_deg) < 10);
    let best = rays[0];
    for (const r of rays) if (!best || r.distance > best.distance) best = r;
    const errBefore = before && target ? angleDelta(target.bearing, before.angle) : null;
    const action = await microTick(s, target);
    actionCounts[action] = (actionCounts[action] || 0) + 1;
    if (DEBUG_TICKS && before) {
      const me = worldToPx(before.x, before.y);
      await bot.log(
        "    t" + t +
        " pose=(" + before.x.toFixed(0) + "," + before.y.toFixed(0) + ")@" + before.angle.toFixed(0) +
        " px=(" + me.px + "," + me.py + ")" +
        " target=" + (target ? target.bearing.toFixed(0) + "/" + target.kind : "none") +
        " avoid=" + (_avoidTicks > 0 && _avoidBearing !== null ? _avoidBearing.toFixed(0) + ":" + _avoidTicks : "none") +
        " useCd=" + _useCooldownTicks + "/post=" + _postUseForwardTicks +
        " err=" + (errBefore === null ? "n/a" : errBefore.toFixed(0)) +
        " fwd=" + (fwd ? fwd.hit + ":" + fwd.distance.toFixed(0) + ":b" + fwd.bearing_deg.toFixed(0) + (fwd.thing_category ? ":" + fwd.thing_category : "") : "?") +
        " best=" + (best ? best.hit + ":" + best.distance.toFixed(0) + ":b" + best.bearing_deg.toFixed(0) : "?") +
        " block96=" + (isBlockingAhead(fwd, 96) ? "Y" : "n") +
        " action=" + action,
      );
    }
    await bot.sleep(TICK_PAUSE_MS);
  }

  // Record this macro's outcome for future history-based decisions.
  const movedDist = Math.hypot(s.player.x - startPose.x, s.player.y - startPose.y);
  history.push({ bearing: targetBearing, dist: movedDist });
  if (history.length > HISTORY_LEN) history.shift();
  if (pick && pick.targetKey && movedDist < 80) {
    failedTargets.set(pick.targetKey, macro + 3);
  }
  await bot.log(
    "  macro " + macro + " moved " + movedDist.toFixed(0) +
    " units actions=" + JSON.stringify(actionCounts),
  );

  if (macro % LOG_EVERY === 0 || macro === STEPS - 1) {
    const clip = clipAroundPlayer(s);
    if (clip) {
      const png = await bot.encodePng(CROP, CROP, clip);
      await bot.logImage(
        png,
        "macro " + macro + " clip " + CROP + "x" + CROP + "px (" +
        (CROP * SCALE) + "x" + (CROP * SCALE) + " units) — things=" + things.size,
      );
    }
  }
}

return "finished " + STEPS + " macros";

