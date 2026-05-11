export const ADJECTIVES = [
  "Grumpy",
  "Ecstatic",
  "Surly",
  "Prepared",
  "Crafty",
  "Alert",
  "Sluggish",
  "Testy",
  "Reluctant",
  "Languid",
  "Passive",
  "Pacifist",
  "Aggressive",
  "Hostile",
  "Bubbly",
  "Giggly",
  "Laughing",
  "Crying",
  "Frowning",
  "Torpid",
  "Lethargic",
  "Manic",
  "Patient",
  "Protective",
  "Philosophical",
  "Enquiring",
  "Debating",
  "Furious",
  "Laid-Back",
  "Easy-Going",
  "Cromulent",
  "Excitable",
  "Tired",
  "Exhausted",
  "Ruminating",
  "Redundant",
  "Sporty",
  "Ginger",
  "Scary",
  "Posh",
  "Baby",
];

export const NOUNS = [
  "Frad",
  "Cacodemon",
  "Arch-Vile",
  "Cyberdemon",
  "Imp",
  "Demon",
  "Mancubus",
  "Arachnotron",
  "Baron",
  "Knight",
  "Revenant",
  "Ettin",
  "Maulotaur",
  "Centaur",
  "Afrit",
  "Serpent",
  "Disciple",
  "Gargoyle",
  "Golem",
  "Lich",
  "Sentinel",
  "Acolyte",
  "Templar",
  "Reaver",
  "Spectre",
];

// Args common to every chocolate-doom invocation. The `-iwad <file>` pair is
// appended by the caller once the user has picked an IWAD on the
// `chooseIwad` screen (see IWADS below).
export const COMMON_ARGS = [
  "-window",
  "-nogui",
  "-nomusic",
  "-config",
  "default.cfg",
  "-servername",
  "doomflare",
  "-nodes",
  "4",
];

// Catalog of supported IWADs. The `url` field is consumed by Emscripten's
// `FS.createPreloadedFile`, which fetches it via XHR (relative URLs resolve
// against the page origin, absolute URLs are loaded directly — provided the
// remote sends permissive CORS headers). The third arg to chocolate-doom's
// `-iwad` is the on-FS filename, hence `file`.
export const IWADS = {
  doom1: {
    file: "doom1.wad",
    url: "doom1.wad",
    label: "Doom 1 (shareware)",
  },
  doom2: {
    // Same-origin proxy at /api/wad/doom2 (see worker/index.ts). The
    // upstream GitHub raw URL doesn't always honour CORS for XHR, so the
    // Worker fetches it server-side and re-emits the bytes from our origin.
    file: "doom2.wad",
    url: "/api/wad/doom2",
    label: "Doom 2 (remote)",
  },
};

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

// Wraps an onClick handler so the user has time to see the .pressable CSS
// press animation before the click side-effect fires. The browser still
// dispatches the click immediately (CSS cannot delay JS events), so we
// schedule the actual handler on a short timeout. 120ms ≈ the duration of
// a perceived "tap": long enough for the bevel inversion to register, short
// enough to feel responsive.
//
// Usage:
//   <a className="btn primary pressable"
//      onClick={withPressDelay(() => setView("next"))} />
export const withPressDelay = <E extends { preventDefault?: () => void }>(
  handler: (e: E) => void,
  ms = 120,
): ((e: E) => void) => {
  return (e: E) => {
    // For <a> elements without a real href, the default click behaviour is
    // a no-op, but we still defensively preventDefault so the timer can't
    // race with navigation in case a caller added href="...".
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

    // Concatenate chunks into one contiguous buffer and hand it back to the
    // bundle as a synthesized Response. The bundle's readAsync() helper
    // immediately calls .arrayBuffer() on this, which resolves with our
    // already-buffered bytes — no second copy of the network traffic.
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
//
// The /chocolate-doom.js script auto-runs on load and reads its config from
// the pre-existing global `Module`. The script can only be initialised once
// per page, so a second boot in the same session forces a hard reload — this
// matches the original silentspacemarine.com behaviour.

let bootedOnce = false;

export const bootDoom = (
  args: string[],
  canvas: HTMLCanvasElement,
  print: any,
  iwad: string,
  onProgress?: any,
): Promise<void> => {
  if (bootedOnce) {
    // The classic Emscripten bundle has already auto-run; we cannot
    // re-initialise it. Force a fresh page so the user can start over.
    window.location.reload();
    return new Promise<void>(() => {
      /* never resolves; reload is in flight */
    });
  }
  bootedOnce = true;

  console.log("args:");
  console.log(args);

  // Install the fetch wrapper *before* appending the chocolate-doom.js
  // script tag so that the bundle's first call to window.fetch (made from
  // its readAsync() helper inside FS_preloadFile) goes through our
  // progress-tracking interceptor.
  const wad = IWADS[iwad];
  const uninstallFetchInterceptor = installFetchProgressInterceptor(
    new Map<string, FetchTarget>([
      [wad.url, { file: wad.file, label: wad.label }],
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
        // Same calls as the original (working) boot path. The fetch
        // wrapper installed above intercepts the resulting XHR/fetch made
        // by readAsync() to emit progress events; the runtime sees a
        // perfectly normal Response and proceeds exactly as before.
        fs.createPreloadedFile("", wad.file, wad.url, true, true);
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
          // All preloads (and therefore all matching fetch() calls) have
          // happened by the time onRuntimeInitialized fires, so it's safe
          // to restore the original fetch before handing control to Doom.
          uninstallFetchInterceptor();
          main(args);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      print,
      printErr: (text:string) => {
        console.error(text);
      },
      setStatus: (text:string) => {
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
