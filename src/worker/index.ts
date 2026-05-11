import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request: Request, env: Env) {
    let url = new URL(request.url);
    let route = url.pathname.slice(1).split("/")[0];

    switch (route) {
      case "api":
        return handleApiRequest(request, env);
      default:
        return new Response("not found ", { status: 404 });
    }
  },
};

async function handleApiRequest(request: Request, env: Env) {
  let url = new URL(request.url);
  let [, method, value] = url.pathname.slice(1).split("/");
  let room: string | boolean = false;

  switch (method) {
    case "ws":
    case "room":
      room = await checkRoom(value, env);

      if (room) {
        let routerObject = env.router.getByName(room);
        return routerObject.fetch(request);
      } else {
        return jsonReply({ reason: "invalid room" }, 404);
      }

    case "newroom": {
      let body: { iwad?: string; type?: string } = await request.json();
      const iwad = body.iwad === "doom2" ? "doom2" : "doom1";
      const type = body.type === "cooperative" ? "cooperative" : "deathmatch";
      room = await createRoom(env);
      await env.router.getByName(room).setConfig({ iwad, type });
      return jsonReply({ room, iwad, type }, 200);
    }

    case "wad": {
      // CORS-bypass proxy for remote IWADs. Emscripten's
      // FS.createPreloadedFile can't fetch the upstream GitHub URL directly
      const upstream = IWAD_PROXY_URLS[value];
      if (!upstream) {
        return jsonReply({ reason: "unknown wad" }, 404);
      }
      const upstreamResponse = await fetch(upstream, {
        // GitHub's raw redirect chain is gzip-incompatible with some Worker
        // intermediaries; passing only the URL keeps the request minimal.
        cf: { cacheEverything: true, cacheTtl: 60 * 60 * 24 * 7 },
      });
      if (!upstreamResponse.ok || !upstreamResponse.body) {
        return jsonReply(
          { reason: "upstream fetch failed", status: upstreamResponse.status },
          502,
        );
      }
      const headers = new Headers();
      headers.set("content-type", "application/octet-stream");
      headers.set("Access-Control-Allow-Origin", "*");
      const len = upstreamResponse.headers.get("content-length");
      if (len) headers.set("content-length", len);
      // Cache aggressively at the edge so the second visit is fast even if
      // the upstream is slow. The WAD content is immutable for our purposes.
      headers.set("cache-control", "public, max-age=604800, immutable");
      return new Response(upstreamResponse.body, {
        status: 200,
        headers,
      });
    }

    default:
      return jsonReply({ reason: "api not found" }, 404);
  }
}

async function checkRoom(perma: string, env: Env) {
  try {
    const parts = perma.split("-");
    const digest = await crypto.subtle.digest(
      { name: "SHA-256" },
      new TextEncoder().encode(parts[0] + env.DOOM_KEY),
    );
    const hash = Array.from(new Uint8Array(digest));
    const hex = hash
      .slice(0, 4)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return parts[1] == hex ? perma : false;
  } catch (e) {
    return false;
  }
}

async function createRoom(env: Env) {
  // newUniqueId creates a randomly generated unique DurableObjectId
  const room = env.router.newUniqueId().toString();
  const digest = await crypto.subtle.digest(
    { name: "SHA-256" },
    new TextEncoder().encode(room + env.DOOM_KEY),
  );
  const hash = Array.from(new Uint8Array(digest));
  const hex = hash
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${room}-${hex}`;
}

async function jsonReply(json: any, status: number) {
  return new Response(JSON.stringify(json), {
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
    },
    status: status,
  });
}

// Allow-list of remote IWADs the proxy is willing to fetch. Keeping this
// server-side prevents `/api/wad/:id` from turning into an open egress
// proxy — a client can only request WAD ids we have explicitly catalogued.
// Keep this in sync with IWADS in src/app/lib/game_tools.ts.
const IWAD_PROXY_URLS: Record<string, string> = {
  doom2:
    "https://github.com/Akbar30Bill/DOOM_wads/raw/refs/heads/master/doom2.wad",
};

export class Router extends DurableObject<Env> {
  private sessions: any[] = [];
  private gameStarted = false;
  private gameEnded = false;
  // serverReady flips to true the moment a host WebSocket is accepted, and
  // back to false when that WS closes/errors. Joiners poll /api/room/:room
  // and refuse to bootDoom -connect until this is true so they don't hit a
  // chocolate-doom "null function" trap connecting to an empty room.
  private serverReady = false;
  private iwad: string = "doom1";
  private type: string = "deathmatch";

  async setConfig(config: { iwad: string; type: string }) {
    this.iwad = config.iwad;
    this.type = config.type;
  }

  async fetch(request: Request) {
    let url = new URL(request.url);
    let [, method, value, submethod] = url.pathname.slice(1).split("/");

    // possible API calls
    // /api/room/{room}
    // /api/room/{room}/started
    // /api/ws/{room}
    // /api/ws/{room}/host

    switch (method) {
      case "room":
        var room = await checkRoom(value, this.env);
        if (room) {
          switch (submethod) {
            // host can call this to signal that the game has started
            case "started":
              this.gameStarted = true;
              break;
          }
          return jsonReply(
            {
              room: room,
              gameStarted: this.gameStarted,
              gameEnded: this.gameEnded,
              serverReady: this.serverReady,
              iwad: this.iwad,
              type: this.type,
            },
            200,
          );
        } else {
          return jsonReply({ reason: "invalid room" }, 404);
        }

      case "ws":
        if (request.headers.get("Upgrade") != "websocket") {
          return new Response("expected websocket", { status: 400 });
        }

        // Get the client's IP address for use with the rate limiter.
        // let ip = request.headers.get('CF-Connecting-IP')

        const [client, server] = Object.values(new WebSocketPair());

        await this.handleSession(server, submethod == "host" ? true : false);
        return new Response(null, { status: 101, webSocket: client });
    }
  }

  async handleSession(webSocket: WebSocket, isHost: boolean) {
    webSocket.accept();

    // Once the host's WebSocket is accepted, joiners polling
    // /api/room/:room can safely advance to bootDoom -connect.
    if (isHost) {
      this.serverReady = true;
    }

    webSocket.addEventListener("message", async (msg) => {
      // packet structure:
      // [4-byte-to-address][4-byte-from-address][doom-packet]
      try {
        let data = msg.data;
        let from = new Uint32Array(data.slice(4, 8))[0];
        let to = new Uint32Array(data.slice(0, 4))[0];
        let i;

        if (from == 1 && to == 0) {
          // Server (uid 1) broadcast packet. The original implementation
          // closed *every* session here on the assumption it was the first
          // hello from a fresh host. In practice chocolate-doom's server
          // emits `from=1, to=0` repeatedly during a session (e.g. when
          // announcing joiners), so resetting all sessions kicked every
          // legitimately-connected client.
          //
          // We still want to handle a host reconnect cleanly: if a *prior*
          // from=1 session exists on a different ws, drop only that one so
          // the new host takes its place. Active client sessions stay
          // intact.
          for (let j = this.sessions.length - 1; j >= 0; j--) {
            const existing = this.sessions[j];
            if (existing.from == 1 && existing.ws !== webSocket) {
              try {
                existing.ws.close(1011, "closing");
              } catch (_e) {
                /* already closed */
              }
              this.sessions.splice(j, 1);
            }
          }
        }

        // if it's a new client, add it to the table of clients
        if (this.sessions.map((c) => c.from).indexOf(from) == -1) {
          let session = { ws: webSocket, from: from, host: isHost };
          this.sessions.push(session);
        }

        // send this packet to the corresponding client
        i = this.sessions.map((c) => c.from).indexOf(to);
        if (i != -1) {
          this.sessions[i].ws.send(data.slice(4));
        }
      } catch (err) {
        webSocket.send(err.toString());
      }
    });

    // On "close" and "error" events, remove the WebSocket from the clients list
    let closeOrErrorHandler = async () => {
      const i = this.sessions.map((e) => e.ws).indexOf(webSocket);
      if (i != -1) {
        this.sessions.splice(i, 1);
      }
      if (isHost) {
        this.gameEnded = true;
        // Host is gone -- new joiners must wait again if a fresh host shows
        // up before the DO is evicted.
        this.serverReady = false;
        // brodcast
        this.sessions.map((s) => {
          const message = "doom: 13, host disconnected";
          const encoded = new TextEncoder().encode(message);
          const payload = new Uint8Array(4 + encoded.length);
          payload.set(encoded, 4);
          s.ws.send(payload);
        });
      }
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);
  }
}
