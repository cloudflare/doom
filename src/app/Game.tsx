import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

// ---------------------------------------------------------------------------
// Globals exposed by CDN scripts in index.html and the side-effecting
// emscripten bundle at /chocolate-doom.js (classic non-MODULARIZE build).
//
// The chocolate-doom.js script reads a pre-existing global `Module` for its
// configuration and auto-runs as soon as it loads, so we set window.Module
// before injecting the <script>. After init, the script attaches helpers
// (FS, callMain, ...) onto that same object and exposes top-level vars on
// window — most notably window.callMain.
// ---------------------------------------------------------------------------

type EmscriptenFS = {
  createPreloadedFile: (
    parent: string,
    name: string,
    url: string,
    canRead: boolean,
    canWrite: boolean,
  ) => void;
};

type EmscriptenModuleConfig = {
  arguments?: string[];
  canvas?: HTMLCanvasElement;
  noInitialRun?: boolean;
  preRun?: () => void;
  postRun?: () => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  setStatus?: (text: string) => void;
  monitorRunDependencies?: (left: number) => void;
  onRuntimeInitialized?: () => void;
  onAbort?: (reason: unknown) => void;
  // Attached by the runtime before preRun fires.
  FS?: EmscriptenFS;
  callMain?: (args: string[]) => unknown;
  calledRun?: boolean;
};

declare global {
  interface Window {
    Module?: EmscriptenModuleConfig;
    callMain?: (args: string[]) => unknown;
    ClipboardJS?: new (selector: string) => {
      on: (event: "success" | "error", cb: () => void) => void;
    };
    nipplejs?: {
      create: (opts: {
        zone: HTMLElement;
        color?: string;
        mode?: "static" | "dynamic" | "semi";
        identifier?: number;
        position?: Record<string, string>;
      }) => NippleJoystick;
    };
  }
}

type NippleJoystick = {
  on: (
    eventName: string,
    cb: (
      evt: { type: string },
      data: {
        direction?: { angle: "left" | "right" | "up" | "down" };
        distance?: number;
        angle?: { degree: number };
      },
    ) => void,
  ) => NippleJoystick;
  destroy?: () => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  "Grumpy", "Ecstatic", "Surly", "Prepared", "Crafty", "Alert", "Sluggish",
  "Testy", "Reluctant", "Languid", "Passive", "Pacifist", "Aggressive",
  "Hostile", "Bubbly", "Giggly", "Laughing", "Crying", "Frowning", "Torpid",
  "Lethargic", "Manic", "Patient", "Protective", "Philosophical", "Enquiring",
  "Debating", "Furious", "Laid-Back", "Easy-Going", "Cromulent", "Excitable",
  "Tired", "Exhausted", "Ruminating", "Redundant", "Sporty", "Ginger", "Scary",
  "Posh", "Baby",
];

const NOUNS = [
  "Frad", "Cacodemon", "Arch-Vile", "Cyberdemon", "Imp", "Demon", "Mancubus",
  "Arachnotron", "Baron", "Knight", "Revenant", "Ettin", "Maulotaur",
  "Centaur", "Afrit", "Serpent", "Disciple", "Gargoyle", "Golem", "Lich",
  "Sentinel", "Acolyte", "Templar", "Reaver", "Spectre",
];

const COMMON_ARGS = [
  "-iwad", "doom1.wad",
  "-window",
  "-nogui",
  "-nomusic",
  "-config", "default.cfg",
  "-servername", "doomflare",
  "-nodes", "4",
];

const ROOM_PATTERN = /^[a-z0-9]+-[a-z0-9]+$/;

const ENDPOINTS = ((): { web: string; base: string; wsbase: string } => {
  if (
    typeof window !== "undefined" &&
    window.location.hostname === "0.0.0.0"
  ) {
    return {
      web: "http://0.0.0.0:8000",
      base: "http://0.0.0.0:8000",
      wsbase: "ws://0.0.0.0:8001",
    };
  }
  return {
    web: "https://silentspacemarine.com",
    base: "https://router.silentspacemarine.com",
    wsbase: "wss://router.silentspacemarine.com",
  };
})();

// Virtual gamepad keycodes
const KEY = {
  left: 37,
  right: 39,
  down: 40,
  up: 38,
  speed: 16,
  fire: 32,
  use: 69,
  enter: 13,
  strafeLeft: 65,
  strafeRight: 68,
};

const NE = [30, 60] as const;
const NW = [120, 150] as const;
const SW = [210, 240] as const;
const SE = [300, 330] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hasWebAssembly = (): boolean => {
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
  return false;
};

const isMobile = (): boolean => {
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

const isTouch = (): boolean =>
  "ontouchstart" in window ||
  navigator.maxTouchPoints > 0 ||
  // legacy IE
  (navigator as unknown as { msMaxTouchPoints?: number }).msMaxTouchPoints !==
    undefined;

const genPetName = (): string => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
};

const sendKey = (
  canvas: HTMLCanvasElement,
  keys: number[],
  type: "keydown" | "keyup",
): void => {
  for (const key of keys) {
    const ev = new Event(type, { bubbles: true }) as Event & {
      keyCode: number;
      which: number;
    };
    ev.keyCode = key;
    ev.which = key;
    canvas.dispatchEvent(ev);
  }
};

// Boot Chocolate Doom (classic Emscripten bundle).
//
// The /chocolate-doom.js script auto-runs on load and reads its config from
// the pre-existing global `Module`. The script can only be initialised once
// per page, so a second boot in the same session forces a hard reload — this
// matches the original silentspacemarine.com behaviour.
type DoomHooks = {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  setStatus?: (text: string) => void;
  onAbort?: (reason: unknown) => void;
};

let bootedOnce = false;

const bootDoom = (
  args: string[],
  canvas: HTMLCanvasElement,
  hooks: DoomHooks,
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

  return new Promise<void>((resolve, reject) => {
    const config: EmscriptenModuleConfig = {
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
        fs.createPreloadedFile("", "doom1.wad", "doom1.wad", true, true);
        fs.createPreloadedFile("", "default.cfg", "default.cfg", true, true);
      },
      onRuntimeInitialized: () => {
        // Mirror the reference index.html: explicit callMain after init.
        const main = window.Module?.callMain ?? window.callMain;
        if (typeof main !== "function") {
          reject(new Error("callMain not exposed by chocolate-doom.js"));
          return;
        }
        try {
          main(args);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      print: hooks.print,
      printErr: hooks.printErr,
      setStatus: hooks.setStatus,
      monitorRunDependencies: () => {
        /* status handled by setStatus */
      },
      onAbort: (reason) => {
        hooks.onAbort?.(reason);
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
    script.onerror = () =>
      reject(new Error("Failed to load /chocolate-doom.js"));
    document.head.appendChild(script);
  });
};

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type Screen =
  | { kind: "noWasm" }
  | { kind: "mobileInfo" }
  | { kind: "home" }
  | { kind: "validating" }
  | { kind: "invalid" }
  | { kind: "tooLate" }
  | {
      kind: "choosePet";
      mode: "host" | "join";
      // For "join", we already know the room.
      room?: string;
    }
  | { kind: "deathmatchOr"; pet: string; room: string }
  | {
      kind: "permalink";
      room: string;
      args: string[];
    }
  | { kind: "game"; args: string[] };

const initialScreen = (pathname: string): Screen => {
  if (!hasWebAssembly()) return { kind: "noWasm" };
  if (isMobile()) return { kind: "mobileInfo" };
  const path = pathname.replace(/^\//, "");
  if (ROOM_PATTERN.test(path)) return { kind: "validating" };
  return { kind: "home" };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Game: FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const joy1Ref = useRef<HTMLDivElement>(null);
  const joy2Ref = useRef<HTMLDivElement>(null);

  const [screen, setScreen] = useState<Screen>(() =>
    initialScreen(location.pathname),
  );
  const [petName, setPetName] = useState<string>(() => genPetName());
  // Footer typewriter state
  const [footerMessages, setFooterMessages] = useState<string[]>([]);
  const [footerIndex, setFooterIndex] = useState<number>(0);

  const room = useMemo(
    () => location.pathname.replace(/^\//, ""),
    [location.pathname],
  );

  // -----------------------------------------------------------------------
  // typewriter() replacement: cycles through messages every 10s on the footer.
  // -----------------------------------------------------------------------
  const typewriter = useCallback((msg: string | string[]) => {
    const arr = Array.isArray(msg) ? msg : [msg];
    setFooterMessages(arr);
    setFooterIndex(0);
  }, []);

  // Cycle through footerMessages.
  useEffect(() => {
    if (footerMessages.length <= 1) return;
    const t = window.setTimeout(() => {
      setFooterIndex((i) => (i + 1) % footerMessages.length);
    }, 10000);
    return () => window.clearTimeout(t);
  }, [footerMessages, footerIndex]);

  // Restart the CSS "writer" animation on each footer update.
  useEffect(() => {
    const f = footerRef.current;
    if (!f) return;
    f.classList.remove("writer");
    // force reflow so the animation restarts
    void f.offsetWidth;
    f.classList.add("writer");
  }, [footerMessages, footerIndex]);

  // -----------------------------------------------------------------------
  // Mobile info screen: show for 5 seconds, then route based on URL.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (screen.kind !== "mobileInfo") return;
    const t = window.setTimeout(() => {
      const path = location.pathname.replace(/^\//, "");
      setScreen(
        ROOM_PATTERN.test(path) ? { kind: "validating" } : { kind: "home" },
      );
    }, 5000);
    return () => window.clearTimeout(t);
  }, [screen.kind, location.pathname]);

  // -----------------------------------------------------------------------
  // Validate room when entering a multiplayer URL.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (screen.kind !== "validating") return;
    typewriter('<h1 class="vspace">Validating room...</h1>');
    let cancelled = false;
    void fetch(`${ENDPOINTS.base}/api/room/${room}`)
      .then((r) => r.json())
      .then((data: { room?: string; gameStarted?: boolean }) => {
        if (cancelled) return;
        if (!data.room) {
          setScreen({ kind: "invalid" });
          return;
        }
        if (data.gameStarted) {
          setScreen({ kind: "tooLate" });
          return;
        }
        // Small delay to mimic the previous setTimeout(... 3000).
        window.setTimeout(() => {
          if (cancelled) return;
          setScreen({ kind: "choosePet", mode: "join", room });
        }, 3000);
      })
      .catch(() => {
        if (!cancelled) setScreen({ kind: "invalid" });
      });
    return () => {
      cancelled = true;
    };
  }, [screen.kind, room, typewriter]);

  // -----------------------------------------------------------------------
  // Auto-redirects for terminal info screens.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (screen.kind === "invalid") {
      const t = window.setTimeout(() => navigate("/", { replace: true }), 3000);
      return () => window.clearTimeout(t);
    }
    if (screen.kind === "tooLate") {
      const t = window.setTimeout(() => navigate("/", { replace: true }), 7000);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [screen.kind, navigate]);

  // -----------------------------------------------------------------------
  // Disable pinch-to-zoom on iOS (matches the original `gesturestart` hack).
  // -----------------------------------------------------------------------
  useEffect(() => {
    const stopGesture = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", stopGesture);
    return () => document.removeEventListener("gesturestart", stopGesture);
  }, []);

  // -----------------------------------------------------------------------
  // Virtual gamepads (nipplejs) - only mount once we are in the game and on
  // a touch device.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (screen.kind !== "game") return;
    if (!isTouch()) return;
    const nipple = window.nipplejs;
    if (!nipple) return;
    const left = joy1Ref.current;
    const right = joy2Ref.current;
    const canvas = canvasRef.current;
    if (!left || !right || !canvas) return;

    const leftJoy = nipple.create({
      zone: left,
      color: "#7d2300",
      mode: "static",
      identifier: 1,
      position: { bottom: "50%", left: "50%" },
    });
    const rightJoy = nipple.create({
      zone: right,
      color: "#7d2300",
      mode: "static",
      identifier: 2,
      position: { bottom: "50%", right: "50%" },
    });

    leftJoy
      .on("start end", (evt) => {
        if (evt.type === "end") {
          sendKey(
            canvas,
            [KEY.left, KEY.right, KEY.down, KEY.up, KEY.speed],
            "keyup",
          );
        }
      })
      .on("move", (_evt, data) => {
        if (!data.direction) return;
        if ((data.distance ?? 0) > 20) {
          let pl = false;
          let pr = false;
          let pd = false;
          let pu = false;
          const deg = data.angle?.degree ?? -1;
          switch (data.direction.angle) {
            case "left":
              pl = true;
              if (deg >= NW[0] && deg <= NW[1]) pu = true;
              if (deg >= SW[0] && deg <= SW[1]) pd = true;
              break;
            case "right":
              pr = true;
              if (deg >= NE[0] && deg <= NE[1]) pu = true;
              if (deg >= SE[0] && deg <= SE[1]) pd = true;
              break;
            case "up":
              pu = true;
              if (deg >= NW[0] && deg <= NW[1]) pl = true;
              if (deg >= NE[0] && deg <= NE[1]) pr = true;
              break;
            case "down":
              pd = true;
              if (deg >= SW[0] && deg <= SW[1]) pl = true;
              if (deg >= SE[0] && deg <= SE[1]) pr = true;
              break;
          }
          sendKey(canvas, [KEY.left], pl ? "keydown" : "keyup");
          sendKey(canvas, [KEY.right], pr ? "keydown" : "keyup");
          sendKey(canvas, [KEY.down], pd ? "keydown" : "keyup");
          sendKey(canvas, [KEY.up], pu ? "keydown" : "keyup");
        } else {
          sendKey(
            canvas,
            [KEY.left, KEY.right, KEY.down, KEY.up, KEY.speed],
            "keyup",
          );
        }
      });

    rightJoy
      .on("start end", (evt) => {
        if (evt.type === "end") {
          sendKey(
            canvas,
            [
              KEY.strafeLeft,
              KEY.strafeRight,
              KEY.fire,
              KEY.use,
              KEY.enter,
            ],
            "keyup",
          );
        }
      })
      .on("move", (_evt, data) => {
        if (!data.direction) {
          sendKey(canvas, [KEY.fire, KEY.enter], "keydown");
          return;
        }
        if ((data.distance ?? 0) > 20) {
          switch (data.direction.angle) {
            case "left":
              sendKey(canvas, [KEY.strafeLeft], "keydown");
              sendKey(canvas, [KEY.fire, KEY.enter], "keyup");
              break;
            case "right":
              sendKey(canvas, [KEY.strafeRight], "keydown");
              sendKey(canvas, [KEY.fire, KEY.enter], "keyup");
              break;
            case "up":
              sendKey(canvas, [KEY.use], "keydown");
              sendKey(canvas, [KEY.fire, KEY.enter], "keyup");
              break;
            case "down":
              sendKey(canvas, [KEY.fire, KEY.enter], "keyup");
              break;
          }
        } else {
          sendKey(canvas, [KEY.fire, KEY.enter], "keydown");
          sendKey(canvas, [KEY.strafeLeft, KEY.strafeRight, KEY.use], "keyup");
        }
      });

    return () => {
      leftJoy.destroy?.();
      rightJoy.destroy?.();
    };
  }, [screen.kind]);

  // -----------------------------------------------------------------------
  // Boot the WASM module when entering the "game" screen.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (screen.kind !== "game") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onContextLost = (e: Event) => {
      window.alert("WebGL context lost. You will need to reload the page.");
      e.preventDefault();
    };
    canvas.addEventListener("webglcontextlost", onContextLost, false);

    const handlePrint = (text: string) => {
      if (text.startsWith("doom: ")) {
        const [idStr, rawMsg] = text.slice(6).split(",");
        const id = Number.parseInt(idStr ?? "", 10);
        let msg: string | string[] | false = rawMsg ?? "";
        switch (id) {
          case 2:
            msg = [
              "Connected to Cloudflare WebSockets. Waiting for other players",
              "Still here, waiting for the host to start the game",
            ];
            break;
          case 9:
            window.setTimeout(() => navigate("/", { replace: true }), 5000);
            break;
          case 10:
            msg = false;
            typewriter([
              "MOVE = MOUSE, WSOP OR ARROWS, SHIFT = RUN, E = USE, AD = STRAFE (OR HOLD C)",
              "TAB = MAP, T = SAY, F = FULLSCREEN, LEFT MOUSE OR SPACE = FIRE",
            ]);
            if (room) {
              void fetch(`${ENDPOINTS.base}/api/room/${room}/started`)
                .then((r) => r.json())
                .then((data: unknown) => {
                  console.log(data);
                  console.log(`router notified that ${room} has started`);
                });
            }
            break;
          case 5:
          case 8:
            msg = false;
            break;
          default:
            msg = (rawMsg ?? "").trim();
            break;
        }
        if (msg) typewriter(msg);
      }
      console.log(text);
    };

    void bootDoom(screen.args, canvas, {
      print: handlePrint,
      printErr: (text) => {
        console.error(text);
      },
      setStatus: (text) => {
        console.log(text);
      },
      onAbort: (reason) => {
        console.error("Doom aborted:", reason);
      },
    }).catch((err) => {
      console.error(err);
    });

    return () => {
      canvas.removeEventListener("webglcontextlost", onContextLost, false);
    };
    // We deliberately depend on screen reference; args are stable per game.
  }, [screen, navigate, room, typewriter]);

  // -----------------------------------------------------------------------
  // Screen-specific transitions
  // -----------------------------------------------------------------------

  const startSolo = useCallback(() => {
    typewriter([
      "W,A,S,D OR ARROWS TO MOVE, Q,E,Z|O TO STRAFE, X|P FOR SPEED, C TO OPEN",
      "TAB SHOWS THE MAP, T TO WRITE (MULTIPLAYER), YOU CAN ALSO USE THE MOUSE",
    ]);
    // -warp 1 1 sets autostart=true and lands directly in E1M1, bypassing
    // D_StartTitle's demo-loop. Demo playback in this WASM build crashes in
    // P_PlayerThink (NULL `mo` deref via `subsector->sector`), so we skip
    // the title cycle for solo. Multiplayer doesn't hit this path because
    // -server/-connect implicitly set netgame=true → G_InitNew.
    setScreen({ kind: "game", args: [...COMMON_ARGS, "-warp", "1", "1"] });
  }, [typewriter]);

  const startMultiplayer = useCallback(() => {
    void fetch(`${ENDPOINTS.base}/api/newroom`)
      .then((r) => r.json())
      .then((data: { room: string }) => {
        setScreen({ kind: "choosePet", mode: "host", room: data.room });
      });
  }, []);

  const onChoosePetSubmit = useCallback(
    (s: Screen & { kind: "choosePet" }) => (pet: string) => {
      const trimmed = pet.trim();
      if (!trimmed) return;
      if (s.mode === "join" && s.room) {
        const args = [
          ...COMMON_ARGS,
          "-pet",
          trimmed,
          "-connect",
          "1",
          "-dup",
          "1",
          "-wss",
          `${ENDPOINTS.wsbase}/api/ws/${s.room}`,
        ];
        typewriter([
          "Connecting to master server. Please wait.",
          "Still trying. Is the master server for this room running?",
        ]);
        setScreen({ kind: "game", args });
      } else if (s.mode === "host" && s.room) {
        setScreen({ kind: "deathmatchOr", pet: trimmed, room: s.room });
      }
    },
    [typewriter],
  );

  const onDeathmatchChoice = useCallback(
    (s: Screen & { kind: "deathmatchOr" }) => (deathmatch: boolean) => {
      const args = [
        ...COMMON_ARGS,
        "-pet",
        s.pet,
        ...(deathmatch ? ["-deathmatch"] : []),
      ];
      setScreen({ kind: "permalink", room: s.room, args });
    },
    [],
  );

  const onPermalinkStart = useCallback(
    (s: Screen & { kind: "permalink" }) => () => {
      const args = [
        ...s.args,
        "-server",
        "-privateserver",
        "-dup",
        "1",
        "-wss",
        `${ENDPOINTS.wsbase}/api/ws/${s.room}`,
      ];
      setScreen({ kind: "game", args });
    },
    [],
  );

  // -----------------------------------------------------------------------
  // ClipboardJS for "Copy Permalink" - bind once a permalink screen mounts.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (screen.kind !== "permalink") return;
    if (!window.ClipboardJS) return;
    const clip = new window.ClipboardJS(".perma");
    return () => {
      // ClipboardJS instances expose a destroy() method; cast safely.
      (
        clip as unknown as { destroy?: () => void }
      ).destroy?.();
    };
  }, [screen.kind]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (screen.kind === "noWasm") {
    return (
      <NoWasmView
        footerRef={footerRef}
        footerHtml={footerMessages[footerIndex] ?? ""}
      />
    );
  }

  if (screen.kind === "mobileInfo") {
    return (
      <>
        <div id="container">
          <div id="mobile" style={{ display: "block" }}>
            <h1>
              For a better mobile experience, click "Hide Toolbar" in the URL
              toolbar
            </h1>
            <img src="hidetoolbar.png" alt="hide toolbar" />
          </div>
        </div>
        <div id="joystick1" ref={joy1Ref} />
        <div id="joystick2" ref={joy2Ref} />
      </>
    );
  }

  const showLogo =
    screen.kind === "home" ||
    screen.kind === "validating" ||
    screen.kind === "tooLate" ||
    screen.kind === "choosePet" ||
    screen.kind === "deathmatchOr";
  const showCanvas = screen.kind === "game";
  const showMenu = !showCanvas;

  return (
    <>
      <div id="container">
        <div id="monitor" style={{ display: "block" }}>
          <div id="monitorscreen">
            <canvas
              id="canvas"
              ref={canvasRef}
              onContextMenu={(e) => e.preventDefault()}
              tabIndex={-1}
              style={{ display: showCanvas ? "" : "none" }}
            />
            {showMenu && (
              <div id="menu">
                <div
                  id="logo"
                  className="vspace"
                  style={{ display: showLogo ? "" : "none" }}
                />
                <MenuContent
                  screen={screen}
                  petName={petName}
                  setPetName={setPetName}
                  onSolo={startSolo}
                  onMultiplayer={startMultiplayer}
                  onChoosePetSubmit={
                    screen.kind === "choosePet"
                      ? onChoosePetSubmit(screen)
                      : undefined
                  }
                  onDeathmatchChoice={
                    screen.kind === "deathmatchOr"
                      ? onDeathmatchChoice(screen)
                      : undefined
                  }
                  onPermalinkStart={
                    screen.kind === "permalink"
                      ? onPermalinkStart(screen)
                      : undefined
                  }
                />
              </div>
            )}
          </div>
          <div
            id="footer"
            ref={footerRef}
            className="writer"
            dangerouslySetInnerHTML={{
              __html: footerMessages[footerIndex] ?? "",
            }}
          />
        </div>
      </div>
      <div id="joystick1" ref={joy1Ref} />
      <div id="joystick2" ref={joy2Ref} />
    </>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const NoWasmView: FC<{
  footerRef: React.RefObject<HTMLDivElement | null>;
  footerHtml: string;
}> = ({ footerRef, footerHtml }) => (
  <div id="container">
    <div id="monitor" style={{ display: "block" }}>
      <div id="monitorscreen">
        <div id="menu">
          <div id="logo" className="vspace" />
          <div id="text">
            <h1 className="vspace">Your browser has no WebAssembly Support</h1>
            <h1 className="vspace">
              You need a modern browser to run this demo
            </h1>
          </div>
        </div>
      </div>
      <div
        id="footer"
        ref={footerRef}
        className="writer"
        dangerouslySetInnerHTML={{ __html: footerHtml }}
      />
    </div>
  </div>
);

type MenuContentProps = {
  screen: Screen;
  petName: string;
  setPetName: (v: string) => void;
  onSolo: () => void;
  onMultiplayer: () => void;
  onChoosePetSubmit?: (pet: string) => void;
  onDeathmatchChoice?: (deathmatch: boolean) => void;
  onPermalinkStart?: () => void;
};

const MenuContent: FC<MenuContentProps> = ({
  screen,
  petName,
  setPetName,
  onSolo,
  onMultiplayer,
  onChoosePetSubmit,
  onDeathmatchChoice,
  onPermalinkStart,
}) => {
  switch (screen.kind) {
    case "home":
      return <HomeMenu onSolo={onSolo} onMultiplayer={onMultiplayer} />;
    case "validating":
    case "tooLate":
    case "invalid":
      return <TextMenu screen={screen} />;
    case "choosePet":
      return (
        <ChoosePetMenu
          petName={petName}
          setPetName={setPetName}
          onSubmit={onChoosePetSubmit ?? (() => undefined)}
        />
      );
    case "deathmatchOr":
      return (
        <DeathmatchOrMenu onChoice={onDeathmatchChoice ?? (() => undefined)} />
      );
    case "permalink":
      return (
        <PermalinkMenu
          room={screen.room}
          onStart={onPermalinkStart ?? (() => undefined)}
        />
      );
    case "game":
    case "noWasm":
    case "mobileInfo":
      return null;
  }
};

// ---------- individual menus ----------

const HomeMenu: FC<{ onSolo: () => void; onMultiplayer: () => void }> = ({
  onSolo,
  onMultiplayer,
}) => {
  const [pressed, setPressed] = useState<"solo" | "multiplayer" | null>(null);
  const click = (which: "solo" | "multiplayer", fn: () => void) => () => {
    setPressed(which);
    window.setTimeout(() => {
      setPressed(null);
      fn();
    }, 100);
  };

  return (
    <>
      <div id="buttons">
        <a
          className={`btn ${pressed === "multiplayer" ? "grey" : "secondary"}`}
          id="multiplayer"
          onClick={click("multiplayer", onMultiplayer)}
        >
          Start Multiplayer
        </a>
        <a
          className={`btn ${pressed === "solo" ? "grey" : "primary"}`}
          id="solo"
          onClick={click("solo", onSolo)}
        >
          Play Solo
        </a>
      </div>
      <div id="text">
        <h1>This is a WebAssembly Doom Port With</h1>
        <h1>
          <span className="h">Multiplayer</span> support running on top of
          Cloudflare's Edge Network
        </h1>
        <h1>
          Using{" "}
          <a
            target="_new"
            href="https://developers.cloudflare.com/workers/"
            className="h"
          >
            Workers
          </a>
          ,{" "}
          <a
            target="_new"
            href="https://developers.cloudflare.com/workers/runtime-apis/websockets"
            className="h"
          >
            Websockets
          </a>{" "}
          and{" "}
          <a
            target="_new"
            href="https://developers.cloudflare.com/workers/runtime-apis/durable-objects"
            className="h"
          >
            Durable Objects
          </a>
        </h1>
        <h1 />
        <h1>
          <a href="https://blog.cloudflare.com/doom-multiplayer-workers">
            Read More About This Cloudflare Experiment
          </a>
        </h1>
      </div>
    </>
  );
};

const TextMenu: FC<{
  screen: Extract<Screen, { kind: "validating" | "tooLate" | "invalid" }>;
}> = ({ screen }) => {
  if (screen.kind === "validating") {
    return (
      <div id="text">
        <h1 className="vspace">Validating room...</h1>
      </div>
    );
  }
  if (screen.kind === "tooLate") {
    return (
      <div id="text">
        <h1 className="vspace">Too late, this game has already started ;(</h1>
        <h1>Redirecting you back...</h1>
      </div>
    );
  }
  return (
    <div id="text">
      <h1>Invalid room. Redirecting.</h1>
    </div>
  );
};

const ChoosePetMenu: FC<{
  petName: string;
  setPetName: (v: string) => void;
  onSubmit: (pet: string) => void;
}> = ({ petName, setPetName, onSubmit }) => {
  const [pressed, setPressed] = useState<"random" | "go" | null>(null);
  const click = (which: "random" | "go", fn: () => void) => () => {
    setPressed(which);
    window.setTimeout(() => {
      setPressed(null);
      fn();
    }, 100);
  };
  const goClass =
    pressed === "go" || petName.length === 0 ? "grey" : "secondary";
  const randomClass = pressed === "random" ? "grey" : "tertiary";
  return (
    <div id="text">
      <h1 className="vspace">Name your pet here</h1>
      <div className="pinput">
        <a
          className={`btn ${randomClass}`}
          id="random"
          onClick={click("random", () => setPetName(genPetName()))}
        >
          {"\u21BB"}
        </a>
        <input
          autoCorrect="off"
          autoComplete="off"
          type="text"
          id="petname"
          maxLength={20}
          value={petName}
          onChange={(e) =>
            setPetName(e.target.value.replace(/[^0-9a-z\-! ]/gi, ""))
          }
        />
        <a
          className={`btn ${goClass}`}
          id="mypet"
          onClick={
            petName.length
              ? click("go", () => onSubmit(petName))
              : undefined
          }
        >
          Go
        </a>
      </div>
    </div>
  );
};

const DeathmatchOrMenu: FC<{ onChoice: (dm: boolean) => void }> = ({
  onChoice,
}) => {
  const [pressed, setPressed] = useState<"dm" | "co" | null>(null);
  const click = (which: "dm" | "co", fn: () => void) => () => {
    setPressed(which);
    window.setTimeout(() => {
      setPressed(null);
      fn();
    }, 100);
  };
  return (
    <div id="text">
      <h1 className="vspace">Chose the type of multiplayer game</h1>
      <a
        className={`btn ${pressed === "dm" ? "grey" : "secondary"}`}
        id="deathmatch"
        onClick={click("dm", () => onChoice(true))}
      >
        Deathmatch
      </a>
      <a
        className={`btn ${pressed === "co" ? "grey" : "primary"}`}
        id="cooperative"
        onClick={click("co", () => onChoice(false))}
      >
        Cooperative
      </a>
    </div>
  );
};

const PermalinkMenu: FC<{ room: string; onStart: () => void }> = ({
  room,
  onStart,
}) => {
  const [pressed, setPressed] = useState<"clip" | "start" | null>(null);
  const click = (which: "clip" | "start", fn: () => void) => () => {
    setPressed(which);
    window.setTimeout(() => {
      setPressed(null);
      fn();
    }, 100);
  };
  const permalink = `${ENDPOINTS.web}/${room}`;
  const display = `${ENDPOINTS.web}/${room.slice(0, 8)}...${room.slice(-8)}`;
  return (
    <div id="text">
      <h1 className="vspace">Doom Multiplayer is about to start</h1>
      <h1 className="vspace">Share this permalink with your friends:</h1>
      <h1>
        <a className="perma h" data-clipboard-text={permalink}>
          {display}
        </a>
      </h1>
      <h1 className="vspace">
        Your friends can join until you start the game
      </h1>
      <h1>Move to next the screen, wait for them, and</h1>
      <h1>then hit space to start the game</h1>
      <h1 />
      <div className="vspace">
        <a
          id="clip"
          className={`btn ${pressed === "clip" ? "grey" : "tertiary"} perma`}
          data-clipboard-text={permalink}
          data-room={room}
          onClick={click("clip", () => undefined)}
        >
          Copy Permalink
        </a>
        <a
          className={`btn ${pressed === "start" ? "grey" : "secondary"}`}
          id="start"
          data-room={room}
          onClick={click("start", onStart)}
        >
          Next
        </a>
      </div>
    </div>
  );
};

export default Game;
