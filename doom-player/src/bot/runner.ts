/**
 * Run user-authored bot code in a codemode sandbox.
 *
 * The bot is plain JavaScript (no imports, no `await import`). Inside
 * the sandbox the bot sees a single namespace, `bot`, whose methods map
 * 1:1 to BotContext methods:
 *
 *   await bot.getState();
 *   await bot.press("up", 200);
 *   await bot.sleep(50);
 *   await bot.log("hp:", state.hud.health);
 *
 * Bot code can be an expression, a statement list, or an async IIFE.
 * Codemode wraps it as `(async () => { <code> })()`, so a top-level
 * `return value;` works to surface a final value.
 *
 * Execution model:
 *
 *   - The bot runs in an isolated Worker (via `WorkerLoader`).
 *   - External fetch / connect are blocked (`globalOutbound: null`).
 *   - Every `bot.*` call is an RPC roundtrip back to this worker,
 *     which routes through the `BotContext` instance and ultimately
 *     into the live `WebMCPClient`. That means `bot.log(...)` is
 *     streamed live — there's no end-of-run buffering on the bot side.
 *
 * The host (caller of `runBot`) is responsible for *all* setup:
 * acquiring the browser session, attaching CDP, enabling WebMCP, and
 * driving the game past the menu screens. By the time `runBot` is
 * invoked the engine should already expose `get_state` / `press_key`.
 */

import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { ResolvedProvider } from "@cloudflare/codemode";
import { BotContext, type BotContextOptions } from "./context";
import type { WebMCPClient } from "../cdp/webmcp";

export interface RunBotOptions extends BotContextOptions {
  /** Bot source code (plain JavaScript). */
  code: string;
  /** WorkerLoader binding from the host env (`env.LOADER`). */
  loader: WorkerLoader;
  /** Live WebMCP client. Must have completed its preroll. */
  webmcp: WebMCPClient;
  /**
   * Hard timeout for the bot, in milliseconds. Defaults to 60_000.
   * Note: this is enforced *inside* the sandboxed worker by codemode,
   * so it bounds bot execution but does not protect against tool calls
   * the host is hanging on.
   */
  timeoutMs?: number;
}

export interface RunBotResult {
  ok: boolean;
  /** The bot's return value, when it completed successfully. */
  result?: unknown;
  /** Error message, when the bot threw or the sandbox timed out. */
  error?: string;
  /**
   * Anything the bot wrote via `console.log` *inside the sandbox*.
   * Note that `bot.log(...)` is streamed live and does NOT appear
   * here — this only captures sandbox-internal console output.
   */
  consoleLogs: string[];
  stats: ReturnType<BotContext["stats"]>;
}

/**
 * Run a bot once. Returns when the bot finishes (success, throw, or
 * timeout). The caller is expected to log RunBotResult.error, if any.
 */
export async function runBot(opts: RunBotOptions): Promise<RunBotResult> {
  const ctx = new BotContext(opts.webmcp, {
    onLog: opts.onLog,
    maxSleepMs: opts.maxSleepMs,
  });

  // The codemode sandbox calls bot.<name>(args) with a single object
  // arg by default. We want familiar positional args
  // (`bot.press("up", 200)`, `bot.sleep(100)`), so we set
  // `positionalArgs: true` on the provider.
  const provider: ResolvedProvider = {
    name: "bot",
    fns: {
      getState: async () => ctx.getState(),
      press: async (key: unknown, holdMs?: unknown) =>
        ctx.press(
          String(key),
          typeof holdMs === "number" ? holdMs : undefined,
        ),
      sleep: async (ms: unknown) =>
        ctx.sleep(typeof ms === "number" ? ms : Number(ms) || 0),
      log: async (...args: unknown[]) => ctx.log(...args),
    },
    positionalArgs: true,
  };

  const executor = new DynamicWorkerExecutor({
    loader: opts.loader,
    timeout: opts.timeoutMs ?? 60_000,
    // Block all outbound network from sandboxed bot code.
    globalOutbound: null,
  });

  const exec = await executor.execute(opts.code, [provider]);

  return {
    ok: !exec.error,
    result: exec.result,
    error: exec.error,
    consoleLogs: exec.logs ?? [],
    stats: ctx.stats(),
  };
}
