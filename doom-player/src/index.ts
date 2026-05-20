import { CDPConnection, CDPSession } from "./cdp/client";
import { WebMCPClient } from "./cdp/webmcp";
import { runBot } from "./bot/runner";
import { preroll } from "./preroll";

interface BrowserSessionResponse {
	sessionId: string;
}

interface TargetInfo {
	targetId: string;
	type: string;
	title: string;
	url: string;
	attached: boolean;
	browserContextId?: string;
}

interface TargetGetTargetsResponse {
	targetInfos: TargetInfo[];
}

// Tools we wait for before kicking off the player. The page registers
// `start_game` first on the React landing screen; the in-engine tools
// (`press_key`, `get_state`, ...) only appear once Doom has booted, so
// we settle for whichever shows up first and let the player drive the
// rest of the flow.
const EXPECTED_DOOM_TOOLS = [
	"start_game",
	"press_key",
	"get_state",
	"get_screenshot",
];

async function acquireBrowserSession(env: Env): Promise<string> {
	const res = await env.BROWSER.fetch("http://fake.host/v1/devtools/browser?lab=true", {
		method: "POST",
	});
	if (!res.ok) {
		throw new Error(`Failed to acquire BR session: ${res.status} ${res.statusText}`);
	}
	const body = (await res.json()) as BrowserSessionResponse;
	if (!body?.sessionId) {
		throw new Error("BR session response is missing sessionId");
	}
	return body.sessionId;
}

async function openBrowserWebSocket(env: Env, sessionId: string): Promise<WebSocket> {
	const res = await env.BROWSER.fetch(`http://fake.host/v1/devtools/browser/${sessionId}`, {
		headers: { Upgrade: "websocket" },
	});
	const ws = res.webSocket;
	if (!ws) {
		throw new Error(
			`BR did not return a WebSocket for session ${sessionId} (status=${res.status})`,
		);
	}
	ws.accept();
	return ws;
}

// One entry from CDP's `/json/list` endpoint. We only care about the
// fields BR is guaranteed to populate.
interface DevtoolsListEntry {
	id: string;
	type?: string;
	url?: string;
	title?: string;
	webSocketDebuggerUrl?: string;
	devtoolsFrontendUrl?: string;
}

/**
 * Look up a target's DevTools frontend URL via BR's `/json/list`
 * proxy. Returns `null` if the endpoint can't be reached or the
 * target id isn't present (e.g. the page closed between attach and
 * lookup); callers should treat the inspector URL as best-effort.
 */
async function fetchDevtoolsEntry(
	env: Env,
	sessionId: string,
	targetId: string,
): Promise<DevtoolsListEntry | null> {
	try {
		const res = await env.BROWSER.fetch(
			`http://fake.host/v1/devtools/browser/${sessionId}/json/list`,
		);
		if (!res.ok) return null;
		const entries = (await res.json()) as DevtoolsListEntry[];
		if (!Array.isArray(entries)) return null;
		return entries.find((e) => e.id === targetId) ?? null;
	} catch {
		return null;
	}
}

async function attachToDoomPage(
	conn: CDPConnection,
	wantUrl: string,
): Promise<{ targetId: string; session: CDPSession; loaded: Promise<void> }> {
	const { targetInfos } = await conn.send<TargetGetTargetsResponse>("Target.getTargets");

	// Browser Rendering sessions start with at least one blank page
	// target. Reuse it (creating a second page leaks browser context
	// and counts as an extra "page" against the session). Prefer a
	// target whose URL is already on the right origin -- that way a
	// reused session that's still on the doom page can skip the
	// navigate roundtrip.
	const wantOrigin = new URL(wantUrl).origin;
	const pages = targetInfos.filter((t) => t.type === "page");
	const onOrigin = pages.find((t) => {
		try {
			return new URL(t.url).origin === wantOrigin;
		} catch {
			return false;
		}
	});
	const target = onOrigin ?? pages[0];
	if (!target) {
		throw new Error(
			`No page target available to attach to. Targets: ${targetInfos
				.map((t) => `${t.type}:${t.url}`)
				.join(", ") || "(none)"}`,
		);
	}

	const session = await conn.attach(target.targetId);
	await session.send("Page.enable");

	// Subscribe to the load event BEFORE we kick the navigation off.
	// CDP fires `Page.loadEventFired` once, on the actual load, and if
	// we wire up the listener after the event has already happened
	// we'll sit there waiting indefinitely. Installing it first is
	// the only race-free pattern.
	const loaded = new Promise<void>((resolve) => {
		const unsubscribe = session.on("Page.loadEventFired", () => {
			unsubscribe();
			resolve();
		});
	});

	// We MUST start every run from a fresh React mount + engine boot.
	// A reused BR session that was mid-game still has the doom wasm
	// loaded with stale state -- `bootedOnce` is set, the engine is
	// inside the main menu / a level / a pause prompt depending on
	// where the previous run left it. Our preroll assumes the React
	// landing screen, so anything other than that breaks the
	// start_game -> choose_iwad -> start_new_game -> menu-keys flow.
	//
	// `Page.navigate` to the same URL is a no-op in CDP, so we either
	// navigate (different URL) or reload (same URL) to force a clean
	// document.
	if (target.url !== wantUrl) {
		await session.send("Page.navigate", { url: wantUrl });
	} else {
		await session.send("Page.reload", { ignoreCache: false });
	}

	return { targetId: target.targetId, session, loaded };
}

/**
 * Wait for the page on `session` to fire `Page.loadEventFired`. We
 * enable the Page domain first; if the page already loaded (a pre-
 * existing tab) we time out gracefully and continue, since WebMCP tools
 * are observable regardless of load state.
 */
/**
 * Race a load promise (typically the one returned by
 * `attachToDoomPage`) against a timeout. Resolves either way; we
 * never throw on timeout because some BR sessions emit `loadEventFired`
 * early enough that we'd race-condition on it, and the subsequent
 * `waitForAnyTool` is itself a useful "page actually mounted" gate.
 */
async function waitForPageLoad(
	loaded: Promise<void>,
	timeoutMs = 30_000,
): Promise<void> {
	await Promise.race([
		loaded,
		new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
	]);
}

/**
 * Race a list of WebMCP tool names: resolve as soon as ANY of them has
 * appeared. Useful for "wait until the doom React app has mounted",
 * since which tool is registered first depends on which screen renders
 * first (`start_game` on the home screen vs `press_key` if we joined a
 * room mid-game).
 */
async function waitForAnyTool(
	webmcp: WebMCPClient,
	names: string[],
	timeoutMs = 20_000,
): Promise<string> {
	const present = () => names.find((n) => webmcp.get(n));
	const initial = present();
	if (initial) return initial;

	return new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(
				new Error(
					`Timed out after ${timeoutMs}ms waiting for any of: ${names.join(", ")}. ` +
						`Current tools: ${webmcp.list().map((t) => t.name).join(", ") || "(none)"}`,
				),
			);
		}, timeoutMs);
		const unsubscribe = webmcp.onToolsChanged(() => {
			const hit = present();
			if (hit) {
				clearTimeout(timeout);
				unsubscribe();
				resolve(hit);
			}
		});
	});
}

// ── Streaming response helper ───────────────────────────────────────

interface StreamSink {
	/** Write one line (newline appended automatically). */
	write: (line: string) => Promise<void>;
	/** Close the underlying writer; safe to call multiple times. */
	close: () => Promise<void>;
	/** Response to return to the client. */
	response: Response;
}

function makeStreamSink(): StreamSink {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const encoder = new TextEncoder();
	const writer = writable.getWriter();
	let closed = false;
	const write = async (line: string) => {
		if (closed) return;
		try {
			await writer.write(encoder.encode(line.endsWith("\n") ? line : line + "\n"));
		} catch {
			closed = true;
		}
	};
	const close = async () => {
		if (closed) return;
		closed = true;
		try {
			await writer.close();
		} catch {
			// ignore
		}
	};
	const response = new Response(readable, {
		status: 200,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			"x-content-type-options": "nosniff",
		},
	});
	return { write, close, response };
}

// ── Boot + preroll ──────────────────────────────────────────────────

interface BootResult {
	conn: CDPConnection;
	session: CDPSession;
	webmcp: WebMCPClient;
	targetId: string;
	sessionId: string;
	firstTool: string;
	/**
	 * DevTools frontend URL for the attached target, as returned by
	 * BR's `/json/list`. `null` if BR didn't surface one or the lookup
	 * failed. Suitable for displaying to a human (open in tab or embed
	 * in an iframe).
	 */
	devtoolsFrontendUrl: string | null;
	/** Raw CDP websocket URL for the target. Same caveat as above. */
	webSocketDebuggerUrl: string | null;
}

/**
 * Acquire a BR session, attach to the doom page, enable WebMCP, and
 * wait for the first doom tool to appear. Caller is responsible for
 * `conn.close()` once finished.
 */
async function bootDoomBrowser(env: Env, doomUrl: string, write: (s: string) => Promise<void>): Promise<BootResult> {
	const sessionId = await acquireBrowserSession(env);
	await write(`# acquired BR session ${sessionId}`);

	const ws = await openBrowserWebSocket(env, sessionId);
	await write(`# opened CDP websocket`);

	const conn = new CDPConnection(ws);
	const { targetId, session, loaded } = await attachToDoomPage(conn, doomUrl);
	await write(`# attached target=${targetId} cdpSession=${session.sessionId}`);

	// Kick off the WebMCP enable + the DevTools URL lookup in
	// parallel with the page load. None of them depend on each
	// other, and the page load itself is dominated by network
	// (4MB hero PNG etc.) so doing them concurrently shaves
	// several seconds off the cold path.
	const webmcp = new WebMCPClient(session);
	const enableP = webmcp
		.enable()
		.then(() => write(`# webmcp enabled`));
	const devtoolsP = fetchDevtoolsEntry(env, sessionId, targetId).then(async (dt) => {
		const devtoolsFrontendUrl = dt?.devtoolsFrontendUrl ?? null;
		const webSocketDebuggerUrl = dt?.webSocketDebuggerUrl ?? null;
		if (devtoolsFrontendUrl) {
			await write(`# devtools: ${devtoolsFrontendUrl}`);
		} else {
			await write(`# devtools: (unavailable)`);
		}
		if (webSocketDebuggerUrl) {
			await write(`# debuggerWs: ${webSocketDebuggerUrl}`);
		}
		return { devtoolsFrontendUrl, webSocketDebuggerUrl };
	});
	const loadedP = loaded.then(() => write(`# page loaded`));

	const [, , { devtoolsFrontendUrl, webSocketDebuggerUrl }] = await Promise.all([
		// Bounded load wait -- some BR sessions deliver
		// `loadEventFired` before our listener attaches; the agent's
		// actual gate is `waitForAnyTool` below, so we don't fail if
		// the load promise sits.
		Promise.race([
			loadedP,
			new Promise<void>((r) => setTimeout(r, 30_000)),
		]),
		enableP,
		devtoolsP,
	]);

	const firstTool = await waitForAnyTool(webmcp, EXPECTED_DOOM_TOOLS);
	await write(`# first doom tool: ${firstTool}`);

	return {
		conn,
		session,
		webmcp,
		targetId,
		sessionId,
		firstTool,
		devtoolsFrontendUrl,
		webSocketDebuggerUrl,
	};
}

// ── Route: /run (user-authored bot via codemode) ────────────────────

interface BotRunRequest {
	code?: string;
	timeoutMs?: number;
}

async function handleRun(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Use POST { code: \"...\" }", {
			status: 405,
			headers: { allow: "POST" },
		});
	}

	let body: BotRunRequest;
	try {
		body = (await request.json()) as BotRunRequest;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return new Response(`Bad JSON body: ${msg}`, { status: 400 });
	}
	const code = typeof body.code === "string" ? body.code : "";
	if (!code.trim()) {
		return new Response(
			"Missing `code` field. Body must be JSON: { code: \"...\", timeoutMs?: number }",
			{ status: 400 },
		);
	}

	const doomUrl = env.DOOM_URL;
	const sink = makeStreamSink();

	const runner = (async () => {
		await sink.write(`# doom-player /run; doomUrl=${doomUrl}`);
		await sink.write(`# bot code: ${code.length} bytes`);
		// Echo the first non-empty, non-comment line of the bot so we
		// can tell at a glance which bot ran (helps catch
		// localStorage-cache mismatches between the editor pane and
		// what was actually POSTed).
		const firstSourceLine = code
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0 && !l.startsWith("//"));
		if (firstSourceLine) {
			const preview =
				firstSourceLine.length > 120
					? `${firstSourceLine.slice(0, 120)}…`
					: firstSourceLine;
			await sink.write(`# bot src: ${preview}`);
		}

		let conn: CDPConnection | null = null;
		try {
			const boot = await bootDoomBrowser(env, doomUrl, sink.write);
			conn = boot.conn;

			// Drive the game past the menus. Bot code starts with the
			// engine already in a playable state.
			await sink.write(`# preroll: starting`);
			await preroll(boot.webmcp, {
				onStep: (step) => {
					void sink.write(`# preroll: ${step}`);
				},
			});
			await sink.write(`# preroll: done`);

			await sink.write(`# bot: starting`);
			const result = await runBot({
				code,
				loader: env.LOADER,
				webmcp: boot.webmcp,
				timeoutMs: body.timeoutMs,
				onLog: (line) => {
					void sink.write(line);
				},
			});

			if (result.ok) {
				await sink.write(`# bot: ok`);
				if (result.result !== undefined) {
					await sink.write(`# bot result: ${safeJson(result.result)}`);
				}
			} else {
				await sink.write(`# bot: error ${result.error}`);
			}
			for (const log of result.consoleLogs) await sink.write(`# console: ${log}`);
			await sink.write(
				`# stats: stateReads=${result.stats.stateReads} keyPresses=${result.stats.keyPresses} sleeps=${result.stats.sleeps} logs=${result.stats.logs}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
			await sink.write(`# ERROR: ${msg}`);
		} finally {
			try {
				conn?.close();
			} catch {
				// ignore
			}
			await sink.close();
		}
	})();

	ctx.waitUntil(runner);
	return sink.response;
}

function safeJson(v: unknown): string {
	try {
		const s = JSON.stringify(v);
		return s.length > 1000 ? `${s.slice(0, 1000)}…(truncated)` : s;
	} catch {
		return String(v);
	}
}

// ── Entry point ─────────────────────────────────────────────────────

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/run") {
			return handleRun(request, env, ctx);
		}
		// Anything else falls through to the static SPA build served by
		// the `ASSETS` binding. The wrangler `assets.not_found_handling
		// = "single-page-application"` rule rewrites unknown paths to
		// `/index.html` automatically.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
