import { IWADS, ADJECTIVES, NOUNS } from "../../lib/common";

// Args common to every chocolate-doom invocation. The `-iwad <file>` pair is
// appended by the caller once the user has picked an IWAD on the
// `chooseIwad` screen (see IWADS below).
//
// We used to pass `-nomusic` here because the upstream OPL_Delay() routine
// deadlocked the wasm main loop on SDL_CondWait waiting for a postmix
// callback that never fired under Emscripten's single-threaded SDL2 (see
// doom/opl/opl.c). That wait has been rewritten to yield via
// emscripten_sleep with an iteration cap, so OPL emulation now drives Web
// Audio normally (synthesised from the WAD's GENMIDI lump, no external
// soundfonts/patches required). Removing -nomusic lets the WASM build play
// the original Doom soundtrack.
export const COMMON_ARGS = [
  "-window",
  "-nogui",
  "-config",
  "default.cfg",
  "-servername",
  "doomflare",
  "-nodes",
  "4",
];

export const ROOM_PATTERN = /^[a-z0-9]+-[a-z0-9]+$/;

// The front-end and the API/WebSocket router are now served by the same
// Worker, so every request is same-origin:
//   * `base` is empty so HTTP fetches resolve as origin-relative paths
//     (e.g. "/api/newroom").
//   * `wsbase` is derived from window.location because chocolate-doom's
//     `-wss` argument requires an absolute ws://|wss:// URL.
//   * `web` is the page origin, used for sharable permalinks.
export const ENDPOINTS = (() => {
  if (typeof window === "undefined") {
    return { web: "", base: "", wsbase: "" };
  }
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return {
    web: window.location.origin,
    base: "",
    wsbase: `${wsProto}//${window.location.host}`,
  };
})();

export const hasWebAssembly = (): boolean => {
  try {
    if (
      typeof WebAssembly === "object" &&
      typeof WebAssembly.instantiate === "function"
    ) {
      const bytes = Uint8Array.of(0, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0);
      const mod = new WebAssembly.Module(bytes);
      if (mod instanceof WebAssembly.Module) {
        return new WebAssembly.Instance(mod) instanceof WebAssembly.Instance;
      }
    }
  } catch {
    // ignore
  }
  console.log("ERROR: WebAssembly not supported.");
  return false;
};

export const isMobile = (): boolean => {
  const tests = [
    /Android/i,
    /webOS/i,
    /iPhone/i,
    /iPad/i,
    /iPod/i,
    /BlackBerry/i,
    /Windows Phone/i,
  ];
  return tests.some((re) => navigator.userAgent.match(re) !== null);
};

export const genPetName = (): string => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
};

export const withPressDelay = <E extends { preventDefault?: () => void }>(
  handler: (e: E) => void,
  ms = 120,
): ((e: E) => void) => {
  return (e: E) => {
    e.preventDefault?.();
    window.setTimeout(() => handler(e), ms);
  };
};

type FetchTarget = { file: string; label: string };

const installFetchProgressInterceptor = (
  targets: Map<string, FetchTarget>,
  onProgress?: any,
): (() => void) => {
  const originalFetch = window.fetch.bind(window);

  const resolveUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") return new URL(input, document.baseURI).href;
    if (input instanceof URL) return input.href;
    return new URL(input.url, document.baseURI).href;
  };

  const targetsByHref = new Map<string, FetchTarget>();
  for (const [k, v] of targets) {
    targetsByHref.set(new URL(k, document.baseURI).href, v);
  }

  window.fetch = async (input, init) => {
    let target: FetchTarget | undefined;
    try {
      target = targetsByHref.get(resolveUrl(input));
    } catch {
      target = undefined;
    }
    if (!target) {
      return originalFetch(input as RequestInfo, init);
    }

    const response = await originalFetch(input as RequestInfo, init);
    if (!response.ok || !response.body) {
      return response;
    }

    const lenHeader = response.headers.get("content-length");
    const total = lenHeader ? Number.parseInt(lenHeader, 10) || 0 : 0;
    onProgress?.({
      file: target.file,
      label: target.label,
      loaded: 0,
      total,
      done: false,
    });

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({
          file: target.file,
          label: target.label,
          loaded,
          total,
          done: false,
        });
      }
    }

    const buf = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    onProgress?.({
      file: target.file,
      label: target.label,
      loaded,
      total: total || loaded,
      done: true,
    });

    return new Response(buf, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return () => {
    if (window.fetch !== originalFetch) {
      window.fetch = originalFetch;
    }
  };
};

// Boot Chocolate Doom (classic Emscripten bundle).

let bootedOnce = false;

export const bootDoom = (
  args: string[],
  canvas: HTMLCanvasElement,
  print: any,
  iwad: string,
  onProgress?: any,
): Promise<void> => {
  if (bootedOnce) {
    window.location.reload();
    return new Promise<void>(() => {});
  }
  bootedOnce = true;

  const wad = IWADS[iwad];
  const url = wad.remote ? `/api/wad/${iwad}` : `${iwad}.wad`;

  const uninstallFetchInterceptor = installFetchProgressInterceptor(
    new Map<string, FetchTarget>([
      [url, { file: `${iwad}.wad`, label: wad.label }],
      ["default.cfg", { file: "default.cfg", label: "Config" }],
    ]),
    onProgress,
  );

  return new Promise<void>((resolve, reject) => {
    const config = {
      canvas,
      arguments: args,
      noInitialRun: true,
      preRun: () => {
        const fs = window.Module?.FS;
        if (!fs) {
          console.error(
            "Doom preRun: FS not attached yet - cannot preload WAD",
          );
          return;
        }
        fs.createPreloadedFile("", `${iwad}.wad`, url, true, true);
        fs.createPreloadedFile("", "default.cfg", "default.cfg", true, true);
      },
      onRuntimeInitialized: () => {
        // Mirror the reference index.html: explicit callMain after init.
        const main = window.Module?.callMain ?? window.callMain;
        if (typeof main !== "function") {
          uninstallFetchInterceptor();
          reject(new Error("callMain not exposed by chocolate-doom.js"));
          return;
        }
        try {
          uninstallFetchInterceptor();
          main(args);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      print,
      printErr: (text: string) => {
        console.error(text);
      },
      setStatus: (text: string) => {
        console.error(text);
      },
      monitorRunDependencies: () => {
        /* status handled by setStatus */
      },
      onAbort: (reason) => {
        console.log(reason);
        uninstallFetchInterceptor();
        reject(
          reason instanceof Error
            ? reason
            : new Error(`Doom aborted: ${String(reason)}`),
        );
      },
    };

    window.Module = config;

    const script = document.createElement("script");
    script.src = "/chocolate-doom.js";
    script.async = true;
    script.onerror = () => {
      uninstallFetchInterceptor();
      reject(new Error("Failed to load /chocolate-doom.js"));
    };
    document.head.appendChild(script);
  });
};

// Thrown when the HTTP response status is not 200.
export class HttpStatusError extends Error {
  status: number;
  response: Response;
  constructor(response: Response) {
    super(`HTTP ${response.status} ${response.statusText}`);
    this.name = "HttpStatusError";
    this.status = response.status;
    this.response = response;
  }
}

// Thrown when the response body cannot be parsed as JSON.
export class InvalidJsonError extends Error {
  cause?: unknown;
  constructor(cause?: unknown) {
    super("Response body is not valid JSON");
    this.name = "InvalidJsonError";
    this.cause = cause;
  }
}

export async function jsonFetch<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  if (response.status !== 200) {
    throw new HttpStatusError(response);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new InvalidJsonError(err);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new InvalidJsonError(err);
  }
}


