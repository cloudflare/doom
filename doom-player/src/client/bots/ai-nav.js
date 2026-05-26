// Hybrid AI navigation with closed-loop steering.
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
// configured (see doom-player wrangler.jsonc `ai` block). Without
// it, `ai` is undefined in this sandbox and the call below throws.

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const STEPS = 5;                // macro consults of the vision LLM
const TICKS_PER_MACRO = 24;     // micro ticks between consults
const TICK_MS = 200;
const TURN_TOLERANCE_DEG = 18;  // dead-band: don't bother correcting <18°
const TURN_HOLD_MIN_MS = 140;   // shortest turn tap
const TURN_HOLD_MAX_MS = 500;   // longest single turn tap (big errors)
// Every field returned by get_state is a snapshot of the last completed
// 35Hz engine tic (see the `get_state` tool description in
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
// world bearing as `player.angle + relative_offset`. No screen-to-world
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
    ? `${p.angle_deg.toFixed(0)}° (${compassLabel(p.angle_deg)})`
    : "(unknown)";
  const poseStr = p
    ? `(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`
    : "(unknown)";

  const rays = state.raycasts || [];
  const raysSorted = [...rays].sort((a, b) => a.bearing_deg - b.bearing_deg);
  const rayLines = raysSorted.map((r) => {
    const sign = r.bearing_deg >= 0 ? "+" : "";
    const extra = r.thing_type ? ` (${r.thing_type})` : "";
    return `  ${sign}${r.bearing_deg.toFixed(0).padStart(3, " ")}°: ${r.hit} @ ${r.distance.toFixed(0)}${extra}`;
  }).join("\n");

  const things = (state.things_visible || []).slice(0, 8).map((t) => {
    const sign = t.bearing_deg >= 0 ? "+" : "";
    return `${t.type} @ ${sign}${t.bearing_deg.toFixed(0)}°/${t.distance.toFixed(0)}`;
  }).join(", ");

  const enemies = (state.enemies_visible || []).map(
    (e) => `${e.type} @ ${e.bearing}/${e.distance}`,
  ).join(", ");

  const hud = state.hud;
  const hudStr = `hp=${hud.health} armor=${hud.armor} ammo=${hud.ammo}(${hud.ammo_type}) weapon=${hud.weapon} keys=[${(hud.keys || []).join(",")}]`;

  const historyLines = [];
  if (history && history.recent && history.recent.length > 0) {
    for (const h of history.recent) {
      historyLines.push(
        `  macro ${h.macro}: picked ${h.turn}, moved ${h.dist.toFixed(0)} units${h.pinned ? " (pinned)" : ""}`,
      );
    }
  }

  return [
    "ENGINE STATE (all bearings are relative to player facing; -=left, +=right):",
    `  facing: ${facingStr}`,
    `  pose:   ${poseStr}`,
    `  hud:    ${hudStr}`,
    "  forward-cone raycasts:",
    rayLines || "    (none)",
    `  things visible: ${things || "(none)"}`,
    `  enemies visible: ${enemies || "(none)"}`,
    historyLines.length > 0
      ? "RECENT MACRO HISTORY:\n" + historyLines.join("\n")
      : "RECENT MACRO HISTORY: (this is the first macro)",
  ].join("\n");
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
    "Black space adjacent to white walls is unexplored territory.\n\n" +
    stateBlock +
    "\n\nDecide where the player should head next, *relative to the " +
    "arrow's current facing*. Use BOTH the map (for big-picture " +
    "exploration) AND the raycasts (for what's physically reachable " +
    "this second). Prefer a direction where the raycasts are open " +
    "(distance > 100, hit != wall). Avoid picking a direction the " +
    "raycasts show as a close wall. If the recent history shows the " +
    "bot was pinned moving the same way, pick a DIFFERENT direction " +
    "this time.\n\n" +
    "Reply with EXACTLY one token from this set, nothing else: " +
    "AHEAD, SOFT_LEFT, HARD_LEFT, SOFT_RIGHT, HARD_RIGHT, BACK.\n" +
    "  AHEAD       = keep current facing\n" +
    "  SOFT_LEFT   = rotate ~45° counter-clockwise\n" +
    "  HARD_LEFT   = rotate ~90° counter-clockwise\n" +
    "  SOFT_RIGHT  = rotate ~45° clockwise\n" +
    "  HARD_RIGHT  = rotate ~90° clockwise\n" +
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
  await bot.log(`  ai prompt (${instructions.length} chars):`);
  for (const line of instructions.split("\n")) await bot.log(`    | ${line}`);
  await bot.log(`  ai (${elapsedMs}ms) raw=${JSON.stringify(text)} -> ${pick}`);
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
    reason: `ray at ${offset}° is ${sample.hit}@${sample.distance.toFixed(0)}; deepest ray = ${b.toFixed(0)}°@${best.distance.toFixed(0)} (${best.hit})`,
  };
}

// Convert a player-relative turn label into an absolute target world
// bearing using the player's current facing.
function turnToTargetBearing(turn, player) {
  if (!player) return null;
  const offset = RELATIVE_TURNS[turn] ?? 0;
  // `offset` is in Doom's CCW-positive convention (LEFT = +45°).
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
// STUCK_POS_EPS note above) and an `actuallyMoving` flag so we can
// distinguish "engine says mom=0 but we just teleported 60 units" from
// "engine says mom=0 and we genuinely haven't moved".
// Returns a short string describing which branch fired, so the caller
// can log it for offline analysis ("why did the bot do X on tick Y?").
async function microTick(state, targetBearing, stuckTicks, actuallyMoving) {
  if (_useCooldown > 0) _useCooldown -= 1;
  if (state.screen !== "playing") {
    await bot.press("enter");
    return `menu(enter) screen=${state.screen}`;
  }

  // 1. Combat: shoot centred enemies, turn toward off-centre ones.
  const enemies = state.enemies_visible || [];
  const centred = enemies.find((e) => e.bearing === "center");
  if (centred) {
    await bot.press("fire", 200);
    return `fire @${centred.type}`;
  }
  const turnTowardEnemy = enemies.find((e) => e.bearing === "left" || e.bearing === "far_left")
    ? "left"
    : enemies.find((e) => e.bearing === "right" || e.bearing === "far_right")
    ? "right"
    : null;
  if (turnTowardEnemy) {
    await bot.press(turnTowardEnemy, 120);
    return `face-enemy ${turnTowardEnemy}`;
  }

  // 2. Doors / switches close ahead -> activate and step through.
  //    Two guards before pressing `use`:
  //      a. the door must be near-centred in the FOV (otherwise we're
  //         not actually facing it; let steering align us first).
  //      b. respect a cooldown — `use` toggles the door, so spamming
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
    return `use ${fwd.hit}@${fwd.distance.toFixed(0)} (cooldown=${USE_COOLDOWN_TICKS})`;
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
    return `pinned: back up (rays=${fwdRays.map((r) => r.distance.toFixed(0)).join(",")})`;
  }

  // 4. Stuck (no momentum for several ticks) -> escape: back up
  //    *then* turn. Backing up reliably breaks contact with whatever
  //    geometry we wedged into; the turn happens on the next tick.
  if (stuckTicks >= STUCK_TICKS) {
    await bot.press("down", 250);
    await bot.press("right", 250);
    return `unstick (stuck=${stuckTicks})`;
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
    return `wall@${fwd.distance.toFixed(0)} turn ${dir} (${targetBiased ? "target-bias" : `deep-ray@${best.bearing_deg.toFixed(0)}`})`;
  }

  // 6. Closed-loop steering toward the macro target bearing.
  if (targetBearing !== null && state.player) {
    const err = angleDelta(targetBearing, state.player.angle_deg);
    if (Math.abs(err) > TURN_TOLERANCE_DEG) {
      // Doom's angles: +y is 90°, -y is 270°. A positive `err` means
      // we need to rotate counter-clockwise, which is the `left` key.
      const hold = turnHoldFor(err);
      const dir = err > 0 ? "left" : "right";
      await bot.press(dir, hold);
      return `steer ${dir} ${hold}ms (err=${err.toFixed(0)}°)`;
    }
  }

  // 7. Heading is good (or no target): walk forward — unless we're
  //    *already* stationary with a wall in range. The default wall-
  //    avoid branch above only fires at distance<48, but a player
  //    facing wall@80 with no actual position progress will sit there
  //    pressing "up" against geometry forever. Escalate to a sideways
  //    turn. We use `actuallyMoving` (position-delta based) here
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
    return `stalled@wall${fwdRay.distance.toFixed(0)} turn ${dir} (deep-ray@${best.bearing_deg.toFixed(0)}@${best.distance.toFixed(0)})`;
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
    "pose:", s.player ? `(${s.player.x.toFixed(0)},${s.player.y.toFixed(0)})@${s.player.angle_deg.toFixed(0)}° (${compassLabel(s.player.angle_deg)})` : "?");

  if (s.screen !== "playing" && s.screen !== "automap") {
    await bot.press("enter");
    await bot.sleep(200);
    continue;
  }

  // --- ONE LLM consult per macro step: image + state digest. ---
  const shot = await snapAutomap(s.screen);
  // Surface the automap to the UI's debug-image panel so a human
  // watching the run can see exactly what the LLM saw.
  await bot.logImage(shot, `macro ${macro} automap (pose ${s.player ? `(${s.player.x.toFixed(0)},${s.player.y.toFixed(0)})@${s.player.angle_deg.toFixed(0)}°` : "?"})`);
  const llmResult = await askMacroTurn(s, shot, history);
  let turn = llmResult.pick;

  // Safety net: if the LLM picked a direction the raycasts say is a
  // close wall, override. Logs both versions so we can tell whether
  // the veto fires too aggressively.
  const veto = vetoTurn(turn, s);
  if (veto.vetoed) {
    await bot.log(`  veto: ${llmResult.pick} -> ${veto.pick} (${veto.reason})`);
    turn = veto.pick;
  } else if (veto.sample) {
    await bot.log(
      `  veto: kept ${llmResult.pick} (ray@${(RELATIVE_TURNS[llmResult.pick] ?? 0)}° = ${veto.sample.hit}@${veto.sample.distance.toFixed(0)})`,
    );
  }

  const targetBearing = turnToTargetBearing(turn, s.player);
  await bot.log(
    "macro turn:", turn,
    targetBearing === null
      ? "(no player pose)"
      : `-> target bearing ${targetBearing.toFixed(0)}° (${compassLabel(targetBearing)}) from facing ${s.player ? s.player.angle_deg.toFixed(0) : "?"}° (${s.player ? compassLabel(s.player.angle_deg) : "?"})`,
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
      return `ended on ${s.screen} after ${macro} macro steps`;
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
    const fwdStr = fwd ? `${fwd.hit}@${fwd.distance.toFixed(0)}` : "(none)";
    const enemiesStr =
      (s.enemies_visible || []).length === 0
        ? "0"
        : (s.enemies_visible || [])
            .map((e) => `${e.type}/${e.bearing}`)
            .join(",");

    const branch = await microTick(s, targetBearing, stuckTicks, actuallyMoving);
    branchCounts[branch.split(" ")[0]] = (branchCounts[branch.split(" ")[0]] || 0) + 1;

    // Log both posDelta (truth) and mom (laggy) so the trace makes
    // the lag visible: you'll often see early ticks with mom=0
    // but pdΔ>0 right after a press.
    await bot.log(
      `  t=${String(t).padStart(2, "0")} ` +
        `pos=(${s.player ? s.player.x.toFixed(0) : "?"},${s.player ? s.player.y.toFixed(0) : "?"}) ` +
        `pdΔ=${posDelta.toFixed(1)} ` +
        `ang=${s.player ? s.player.angle_deg.toFixed(0) : "?"}° err=${err.toFixed(0)}° ` +
        `mom=(${s.player ? s.player.momx.toFixed(1) : "?"},${s.player ? s.player.momy.toFixed(1) : "?"}) ` +
        `spd=${speed.toFixed(1)} stuck=${stuckTicks} ` +
        `fwd=${fwdStr} enemies=${enemiesStr} hp=${s.hud.health} ` +
        `-> ${branch}`,
    );

    // Reset the counter right after we kicked an unstick so we don't
    // chain unstick branches forever.
    if (stuckTicks >= STUCK_TICKS) stuckTicks = 0;
    await bot.sleep(TICK_MS - 80);
  }

  // Per-macro summary: how far did we actually move, and which
  // branches dominated? Also fed back into `history` so the next
  // LLM consult knows whether we got stuck.
  if (s.player && startPose) {
    const dx = s.player.x - startPose.x;
    const dy = s.player.y - startPose.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const branchStr = Object.entries(branchCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const pinned = dist < 32 ||
      (branchCounts["pinned:"] || 0) + (branchCounts["unstick"] || 0) > 6;
    await bot.log(
      `  macro ${macro} summary: moved ${dist.toFixed(0)} units, branches: ${branchStr}${pinned ? " [PINNED]" : ""}`,
    );
    history.recent.push({ macro, turn, dist, pinned });
    if (history.recent.length > 3) history.recent.shift();
  }
}

return `finished ${STEPS} macro steps`;
