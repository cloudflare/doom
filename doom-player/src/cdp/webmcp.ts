/**
 * Wrapper around the Chrome DevTools Protocol "WebMCP" domain.
 *
 * Spec: https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/
 *
 * The domain surfaces page-registered `navigator.modelContext` tools to a
 * CDP client. Once enabled, the browser fires `WebMCP.toolsAdded` /
 * `WebMCP.toolsRemoved` events as the page registers / unregisters tools,
 * and we drive tool invocations with `WebMCP.invokeTool` plus the matching
 * `WebMCP.toolResponded` event keyed by `invocationId`.
 *
 * In the Doom case the page is the agentic-doom worker (default
 * `agentic-doom.rui-figueira.workers.dev`), which uses the
 * `@mcp-b/webmcp-polyfill` to install `navigator.modelContext`. The polyfill
 * fires the same DOM-level events the native Chromium implementation does,
 * so the CDP domain sees the same tool list either way.
 *
 * This wrapper is deliberately minimal: it tracks the live tool registry
 * and exposes `invoke(name, input)` returning a structured result. It does
 * NOT do reconnect, retry, or input validation — playbooks are trusted
 * code and we want errors to surface verbatim.
 */

import type { CDPSession } from "./client";

// ── Types mirroring the CDP WebMCP domain ────────────────────────────

export interface WebMCPAnnotation {
  readOnly?: boolean;
  untrustedContent?: boolean;
  autosubmit?: boolean;
}

export interface WebMCPTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  annotations?: WebMCPAnnotation;
  /** Frame in which the tool is registered. Required for invokeTool. */
  frameId: string;
}

export interface WebMCPRemovedTool {
  name: string;
  frameId: string;
}

export type InvocationStatus = "Completed" | "Canceled" | "Error";

export interface ToolRespondedEvent {
  invocationId: string;
  status: InvocationStatus;
  /** Present only when status === "Completed". */
  output?: unknown;
  /** Present on protocol-level errors. */
  errorText?: string;
  /** Present when the page-side execute() threw. */
  exception?: { description?: string; value?: unknown };
}

export interface InvokeResult {
  status: InvocationStatus;
  output?: unknown;
  errorText?: string;
  exception?: { description?: string; value?: unknown };
}

// ── Client ───────────────────────────────────────────────────────────

/**
 * One per session/page. Call `enable()` exactly once before invoking
 * anything else; call `dispose()` on shutdown.
 */
export class WebMCPClient {
  #session: CDPSession;
  #tools = new Map<string, WebMCPTool>();
  #pending = new Map<
    string,
    { resolve: (r: InvokeResult) => void; reject: (e: Error) => void }
  >();
  #disposers: Array<() => void> = [];
  #toolsChangedListeners = new Set<() => void>();
  #enabled = false;

  constructor(session: CDPSession) {
    this.#session = session;
  }

  /**
   * Enable the WebMCP domain. Chrome will immediately fire `toolsAdded`
   * for every currently-registered tool, so by the time this resolves the
   * initial tool list has been observed.
   *
   * Note: the event delivery happens between the `enable` send and its
   * response, so we wire up listeners *before* sending.
   */
  async enable(): Promise<void> {
    if (this.#enabled) return;
    this.#enabled = true;

    this.#disposers.push(
      this.#session.on("WebMCP.toolsAdded", (params) => {
        const tools = (params as { tools?: WebMCPTool[] }).tools ?? [];
        for (const tool of tools) {
          this.#tools.set(tool.name, tool);
        }
        this.#fireToolsChanged();
      }),
    );

    this.#disposers.push(
      this.#session.on("WebMCP.toolsRemoved", (params) => {
        const removed = (params as { tools?: WebMCPRemovedTool[] }).tools ?? [];
        for (const r of removed) {
          this.#tools.delete(r.name);
        }
        this.#fireToolsChanged();
      }),
    );

    this.#disposers.push(
      this.#session.on("WebMCP.toolResponded", (params) => {
        const ev = params as ToolRespondedEvent;
        const resolver = this.#pending.get(ev.invocationId);
        if (!resolver) return;
        this.#pending.delete(ev.invocationId);
        resolver.resolve({
          status: ev.status,
          output: ev.output,
          errorText: ev.errorText,
          exception: ev.exception,
        });
      }),
    );

    // Optional: log invocation starts at debug level. We don't need them
    // for correctness because invokeTool's response carries the id we
    // correlate against, but they're useful for tracing.
    this.#disposers.push(
      this.#session.on("WebMCP.toolInvoked", () => {
        // no-op for now
      }),
    );

    await this.#session.send("WebMCP.enable");
  }

  async disable(): Promise<void> {
    if (!this.#enabled) return;
    this.#enabled = false;
    for (const dispose of this.#disposers) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    this.#disposers = [];
    try {
      await this.#session.send("WebMCP.disable");
    } catch {
      // Best-effort; the page may already be torn down.
    }
    const err = new Error("WebMCP client disposed");
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  /** Live snapshot of every currently-registered tool. */
  list(): WebMCPTool[] {
    return [...this.#tools.values()];
  }

  get(name: string): WebMCPTool | undefined {
    return this.#tools.get(name);
  }

  /**
   * Subscribe to "the tool registry changed". Fires after any
   * `toolsAdded` or `toolsRemoved` event. Useful for rebuilding the
   * codemode descriptor when a screen transition changes the active
   * tool set.
   */
  onToolsChanged(handler: () => void): () => void {
    this.#toolsChangedListeners.add(handler);
    return () => {
      this.#toolsChangedListeners.delete(handler);
    };
  }

  /**
   * Wait until every name in `names` has been registered. Resolves
   * immediately if the registry already contains them. Useful right
   * after `enable()` to block until the doom page has finished
   * registering its pre-game tools.
   */
  waitForTools(names: string[], timeoutMs = 15000): Promise<void> {
    const missing = () => names.filter((n) => !this.#tools.has(n));
    if (missing().length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        const stillMissing = missing();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for WebMCP tools: ${stillMissing.join(", ")}`,
          ),
        );
      }, timeoutMs);
      const unsubscribe = this.onToolsChanged(() => {
        if (missing().length === 0) {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * Invoke a registered tool. Returns the raw `toolResponded` payload.
   * Throws only if the tool is not registered or the CDP request itself
   * fails — page-side execute() errors come back as
   * `{ status: "Error", exception, errorText }`.
   */
  async invoke(
    toolName: string,
    input: Record<string, unknown> = {},
  ): Promise<InvokeResult> {
    const tool = this.#tools.get(toolName);
    if (!tool) {
      throw new Error(
        `WebMCP tool "${toolName}" is not registered. Available: ${[...this.#tools.keys()].join(", ") || "(none)"}`,
      );
    }
    const { invocationId } = await this.#session.send<{ invocationId: string }>(
      "WebMCP.invokeTool",
      {
        frameId: tool.frameId,
        toolName,
        input,
      },
    );
    return new Promise<InvokeResult>((resolve, reject) => {
      this.#pending.set(invocationId, { resolve, reject });
    });
  }

  /**
   * Cancel a pending invocation by id. We don't currently expose
   * invocation ids to callers, but the hook is here for future use.
   */
  async cancel(invocationId: string): Promise<void> {
    await this.#session.send("WebMCP.cancelInvocation", { invocationId });
  }

  #fireToolsChanged(): void {
    for (const handler of this.#toolsChangedListeners) {
      try {
        handler();
      } catch (err) {
        console.error("[webmcp] onToolsChanged handler threw:", err);
      }
    }
  }
}
