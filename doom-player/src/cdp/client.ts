/**
 * Minimal CDP (Chrome DevTools Protocol) client that talks JSON-RPC over a
 * Cloudflare Worker WebSocket — the kind returned by Browser Rendering's
 * `/v1/devtools/browser/:sessionId` endpoint.
 *
 * Two layers:
 *
 *   - {@link CDPConnection} wraps the raw socket and does id-correlated
 *     request/response plus event fan-out at the browser scope.
 *   - {@link CDPSession} is a thin view of the same socket scoped to a
 *     specific target via `Target.attachToTarget(flatten=true)`. All sends
 *     from a session are tagged with its `sessionId`; incoming messages are
 *     routed back to the right session by inspecting the `sessionId` field
 *     on responses and events.
 *
 * No reconnect logic. If the socket closes mid-run the playbook just
 * errors out — the caller can retry the whole HTTP request.
 *
 * References:
 *  - https://chromedevtools.github.io/devtools-protocol/tot/
 *  - https://github.com/aslushnikov/getting-started-with-cdp/
 */

type Resolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type EventHandler = (params: unknown) => void;

/**
 * Browser-scoped CDP connection. Construct one per WebSocket; spawn
 * {@link CDPSession} instances off it via {@link attach}.
 */
export class CDPConnection {
  #ws: WebSocket;
  #nextId = 1;
  /** Pending requests at the browser scope (no sessionId). */
  #pending = new Map<number, Resolver>();
  /** Pending requests per-session, keyed by sessionId then by id. */
  #pendingBySession = new Map<string, Map<number, Resolver>>();
  /** Listeners at the browser scope. */
  #listeners = new Map<string, Set<EventHandler>>();
  /** Listeners per-session, keyed by sessionId then by event method. */
  #listenersBySession = new Map<string, Map<string, Set<EventHandler>>>();
  #closed = false;
  #closeError: Error | null = null;

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => this.#onMessage(ev));
    ws.addEventListener("close", (ev) => this.#onClose(ev));
    ws.addEventListener("error", () => this.#onError());
  }

  /**
   * Browser-scope request. Use this for `Target.*` and other
   * browser-level methods.
   */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        this.#closeError ?? new Error("CDP connection is closed"),
      );
    }
    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.#ws.send(payload);
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Subscribe to a browser-scope event.
   * @returns disposer
   */
  on(method: string, handler: EventHandler): () => void {
    let bucket = this.#listeners.get(method);
    if (!bucket) {
      bucket = new Set();
      this.#listeners.set(method, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket!.delete(handler);
    };
  }

  /**
   * Attach to a target (typically a page) and return a session-scoped
   * client. Uses `flatten: true` so we keep speaking on the same socket
   * with a `sessionId` tag rather than nesting `Target.sendMessageToTarget`
   * envelopes.
   */
  async attach(targetId: string): Promise<CDPSession> {
    const { sessionId } = await this.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    return new CDPSession(this, sessionId);
  }

  /** @internal — called by CDPSession.send */
  _sendOnSession<T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        this.#closeError ?? new Error("CDP connection is closed"),
      );
    }
    const id = this.#nextId++;
    const payload = JSON.stringify({ id, sessionId, method, params });
    let bucket = this.#pendingBySession.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.#pendingBySession.set(sessionId, bucket);
    }
    return new Promise<T>((resolve, reject) => {
      bucket!.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.#ws.send(payload);
      } catch (err) {
        bucket!.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** @internal — called by CDPSession.on */
  _onSession(
    sessionId: string,
    method: string,
    handler: EventHandler,
  ): () => void {
    let perSession = this.#listenersBySession.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      this.#listenersBySession.set(sessionId, perSession);
    }
    let bucket = perSession.get(method);
    if (!bucket) {
      bucket = new Set();
      perSession.set(method, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket!.delete(handler);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
  }

  #onMessage(ev: MessageEvent): void {
    let msg:
      | {
          id?: number;
          sessionId?: string;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        }
      | null = null;
    try {
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      msg = JSON.parse(raw);
    } catch {
      // Drop garbage frames.
      return;
    }
    if (!msg) return;

    // Response to a previous request.
    if (typeof msg.id === "number") {
      const bucket = msg.sessionId
        ? this.#pendingBySession.get(msg.sessionId)
        : this.#pending;
      const resolver = bucket?.get(msg.id);
      if (!resolver) return;
      bucket!.delete(msg.id);
      if (msg.error) {
        resolver.reject(
          new CDPError(msg.error.code, msg.error.message, msg.error.data),
        );
      } else {
        resolver.resolve(msg.result);
      }
      return;
    }

    // Event.
    if (typeof msg.method === "string") {
      const params = msg.params ?? {};
      if (msg.sessionId) {
        const perSession = this.#listenersBySession.get(msg.sessionId);
        const bucket = perSession?.get(msg.method);
        if (bucket) {
          for (const handler of bucket) handler(params);
        }
      } else {
        const bucket = this.#listeners.get(msg.method);
        if (bucket) {
          for (const handler of bucket) handler(params);
        }
      }
    }
  }

  #onClose(ev: CloseEvent): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = new Error(
      `CDP connection closed (code=${ev.code}, reason=${ev.reason || "n/a"})`,
    );
    this.#rejectAllPending();
  }

  #onError(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = new Error("CDP connection errored");
    this.#rejectAllPending();
  }

  #rejectAllPending(): void {
    const err = this.#closeError ?? new Error("CDP connection closed");
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
    for (const bucket of this.#pendingBySession.values()) {
      for (const { reject } of bucket.values()) reject(err);
      bucket.clear();
    }
    this.#pendingBySession.clear();
  }
}

/**
 * A CDP session scoped to a single target (typically a page).
 */
export class CDPSession {
  readonly sessionId: string;
  #conn: CDPConnection;

  constructor(conn: CDPConnection, sessionId: string) {
    this.#conn = conn;
    this.sessionId = sessionId;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#conn._sendOnSession<T>(this.sessionId, method, params);
  }

  on(method: string, handler: EventHandler): () => void {
    return this.#conn._onSession(this.sessionId, method, handler);
  }
}

export class CDPError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(`CDP error ${code}: ${message}`);
    this.name = "CDPError";
    this.code = code;
    this.data = data;
  }
}
