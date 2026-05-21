/**
 * Pre-roll: drive the React landing page through the IWAD picker,
 * skill selector, and into a playable level.
 *
 * Lives outside the codemode sandbox because:
 *
 *   - It uses tools (`start_game`, `choose_iwad`, `start_new_game`)
 *     that only exist on the React app and disappear once the engine
 *     boots; bot code shouldn't have to worry about which tools are
 *     present.
 *   - It depends on `waitForTools`, which subscribes to the WebMCP
 *     polyfill's toolsAdded events via CDP -- that's a host concern.
 *   - The bot's contract is "engine is already playable when you
 *     start", so all this menu/loading minutiae must complete before
 *     `runBot()` is invoked.
 */

import type { WebMCPClient } from "./cdp/webmcp";
import {
  McpEngineError,
  extractTextFromInvokeResult,
} from "./cdp/mcpPayload";

const DEFAULT_SETTLE_MS = 50;
const READINESS_TIMEOUT_MS = 3_000;

export interface PrerollOptions {
  /**
   * Short delay between menu keystrokes, ms. Most of the wait is
   * gated by `waitForTools`; this is just enough for the engine to
   * apply a keystroke before the next one is sent. Defaults to 50ms.
   */
  settleMs?: number;
  /**
   * Reports progress as the preroll advances. Useful for streaming
   * the trace to a client.
   */
  onStep?: (step: string) => void;
}

/**
 * Drive the home page -> IWAD picker -> engine title -> episode
 * picker -> skill picker -> playable level. Returns once `get_state`
 * yields a parseable state with screen != "unknown".
 */
export async function preroll(
  webmcp: WebMCPClient,
  opts: PrerollOptions = {},
): Promise<string[]> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const onStep = opts.onStep ?? (() => {});
  const actions: string[] = [];

  const record = (action: string) => {
    actions.push(action);
    onStep(action);
  };
  const beat = () => sleep(settleMs);
  const invokeIfPresent = async (
    name: string,
    input: Record<string, unknown> = {},
  ) => {
    if (!webmcp.get(name)) return;
    const res = await webmcp.invoke(name, input);
    if (res.status !== "Completed") {
      throw new Error(
        `preroll: ${name} -> ${res.status} ${res.errorText ?? ""}`,
      );
    }
  };

  // 1. React landing page. `start_game` only exists here. Once
  //    called, the IWAD picker mounts and registers `choose_iwad`.
  if (webmcp.get("start_game")) {
    await invokeIfPresent("start_game", { mode: "solo" });
    record("start_game");
    try {
      await webmcp.waitForTools(["choose_iwad"], 5_000);
    } catch {
      // Already past the picker, or never showed up; fall through.
    }
  }

  // 2. IWAD picker. Picking the IWAD triggers the wasm download +
  //    Emscripten boot -- the biggest single wait in the preroll.
  //    `waitForTools` resolves the instant the engine registers
  //    `start_new_game`.
  if (webmcp.get("choose_iwad")) {
    await invokeIfPresent("choose_iwad", { iwad: "doom1" });
    record("choose_iwad");
    try {
      await webmcp.waitForTools(["start_new_game"], 15_000);
    } catch {
      // Engine might already be in demo mode; press_key handler
      // below covers that case.
    }
  }

  // 3. Engine title screen. `start_new_game` clicks the React-side
  //    "Start New Game" button, which sends Esc+Enter to the engine
  //    and lands us on the episode picker.
  if (webmcp.get("start_new_game")) {
    await invokeIfPresent("start_new_game", {});
    record("start_new_game");
  }

  // 4. From here on the menu is keyboard-driven via press_key, so we
  //    need the engine tools. If they're not up yet, give them a
  //    short grace period and bail out -- the caller's readiness
  //    wait will handle late arrivals.
  try {
    await webmcp.waitForTools(["press_key"], 10_000);
  } catch {
    return actions;
  }

  // 5. Episode picker -> default ("Knee-Deep in the Dead") is fine.
  await invokeIfPresent("press_key", { key: "enter" });
  record("episode_enter");
  await beat();

  // 6. Skill picker -> default cursor is "Hurt me plenty" (skill 3).
  //    Nudge up once to "Hey, Not Too Rough" (skill 2), then confirm.
  await invokeIfPresent("press_key", { key: "up" });
  record("skill_up");
  await beat();
  await invokeIfPresent("press_key", { key: "enter" });
  record("skill_enter");

  // 7. Wait until `get_state` returns a parseable, non-`unknown`
  //    payload. Right after the skill-confirm Enter the engine
  //    spends ~100-500ms transitioning into the level: during that
  //    window wmcp_get_state_json() can return an error or a state
  //    with screen="unknown". Polling here means the bot's first
  //    `bot.getState()` call always succeeds.
  const ready = await waitForReadyState(webmcp, READINESS_TIMEOUT_MS);
  record(ready ? "ready" : "ready_timeout");

  return actions;
}

/**
 * Poll `get_state` until it returns a parseable state with a
 * non-`unknown` screen, or until the deadline elapses.
 */
async function waitForReadyState(
  webmcp: WebMCPClient,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await webmcp.invoke("get_state", {});
      if (res.status === "Completed") {
        const text = extractTextFromInvokeResult(res);
        if (text) {
          const parsed = JSON.parse(text) as { screen?: string };
          if (parsed.screen && parsed.screen !== "unknown") return true;
        }
      }
    } catch (err) {
      // McpEngineError or JSON parse failure both mean "not ready
      // yet"; retry until the deadline.
      if (!(err instanceof McpEngineError) && !(err instanceof SyntaxError)) {
        // Some other error; bail rather than spinning.
        return false;
      }
    }
    await sleep(100);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
