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
// enemies → unstick → open doors → take exits → grab useful
// pickups → navigate toward the deepest open ray. Designed to clear
// a level autonomously without an LLM in the loop.
const AUTOPLAY_BOT = `// Deterministic Doom auto-player.
//
// Priority each tick (highest first):
//   1. Centre-FOV enemy   -> fire
//   2. Off-centre enemy   -> turn toward it
//   3. Hard wedge (>=6 stationary ticks) -> 700ms right turn
//   4. Door at <=80 units -> press use, step forward
//   5. Exit at <=200 units -> press use, step forward
//   6. Useful pickup      -> turn toward / approach it (sticky)
//   7. Soft wedge (>=3 stationary ticks) -> 350ms right turn
//   8. Navigate           -> follow deepest open ray
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

  // 4. Door right in front -> use it, step forward.
  const doorRay = state.raycasts.find(
    (r) => r.hit === "door" && r.distance <= 80,
  );
  if (doorRay && doorCooldown === 0) {
    await bot.press("use", 80);
    await bot.press("forward", 300);
    doorCooldown = DOOR_COOLDOWN;
    return "open_door(d=" + doorRay.distance + ")";
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
const INSPECT_BOT = `// Dump a single state snapshot and quit.
const s = await bot.getState();
await bot.log("screen:", s.screen);
await bot.log("hud:", JSON.stringify(s.hud));
await bot.log("player:", JSON.stringify(s.player));
await bot.log("raycasts:", s.raycasts.length, "things:", s.things_visible.length,
  "enemies:", s.enemies_visible.length);
for (const r of s.raycasts) {
  await bot.log("  ray", r.bearing_deg.toFixed(0) + "deg",
    "hit:", r.hit, "d:", r.distance,
    r.thing_type ? "(" + r.thing_type + ")" : "");
}
return s;
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
];

const STARTER_CODE = AUTOPLAY_BOT;
const STORAGE_KEY = "doom-player-bot-code";

type Mode = "idle" | "running";

export function App() {
	const [code, setCode] = useState<string>(() => {
		try {
			return localStorage.getItem(STORAGE_KEY) ?? STARTER_CODE;
		} catch {
			return STARTER_CODE;
		}
	});
	const [log, setLog] = useState<string[]>([]);
	const [mode, setMode] = useState<Mode>("idle");
	const [devtoolsUrl, setDevtoolsUrl] = useState<string | null>(null);
	// Embed the DevTools pane by default; bot logs stay accessible via
	// the "Show log" toggle. Each fresh run flips this back on so a
	// reused browser session re-shows the inspector.
	const [showDevtools, setShowDevtools] = useState<boolean>(true);
	const abortRef = useRef<AbortController | null>(null);
	const logPaneRef = useRef<HTMLPreElement | null>(null);

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, code);
		} catch {
			// ignore quota / disabled storage
		}
	}, [code]);

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
	// (devtools URL, etc). Recognise them here and forward to state.
	const handleLine = useCallback((line: string) => {
		const dt = line.match(/^# devtools: (.+)$/);
		if (dt) {
			const raw = dt[1].trim();
			if (raw && raw !== "(unavailable)") {
				// Force the full DevTools UI (vs the inline debugger
				// drawer that's used inside Chrome itself). `mode=tab`
				// is a query param the DevTools frontend reads on load.
				const sep = raw.includes("?") ? "&" : "?";
				const url = raw.includes("mode=") ? raw : `${raw}${sep}mode=tab`;
				setDevtoolsUrl(url);
				// Whenever a new URL arrives, flip the embed back on
				// so a re-run automatically shows the inspector again.
				setShowDevtools(true);
			}
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
		setDevtoolsUrl(null);
		const ac = new AbortController();
		abortRef.current = ac;
		try {
			append(`# POST /run (${code.length} bytes)`);
			const resp = await fetch("/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code }),
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

	const clearLog = useCallback(() => setLog([]), []);
	const resetCode = useCallback(() => setCode(STARTER_CODE), []);
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
						<button
							type="button"
							onClick={clearLog}
							disabled={log.length === 0}
						>
							Clear
						</button>
					</div>
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
				</section>
			</div>
		</div>
	);
}
