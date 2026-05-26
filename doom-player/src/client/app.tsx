import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";

// Bot example scripts. Each is a real .js file under ./bots/ and
// is shipped to the codemode sandbox verbatim as a string via
// Vite's `?raw` import suffix. See AGENTS notes in the README.
import SIMPLE_BOT from "./bots/simple.js?raw";
import COMBAT_BOT from "./bots/combat.js?raw";
import AUTOPLAY_BOT from "./bots/autoplay.js?raw";
import EXPLORE_BOT from "./bots/explore.js?raw";
import INSPECT_BOT from "./bots/inspect.js?raw";
import AI_NAV_BOT from "./bots/ai-nav.js?raw";

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
	{ id: "explore", label: "Explore: memory-map (no LLM)", code: EXPLORE_BOT },
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
