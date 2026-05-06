import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  hasWebAssembly,
  isMobile,
  genPetName,
  ENDPOINTS,
  COMMON_ARGS,
  ROOM_PATTERN,
} from "../lib/game_tools";
import { VirtualJoysticks } from "./VirtualJoysticks";
import type {
  ChoosePetMenuProps,
  DeathmatchOrMenuProps,
  DoomHooks,
  EmscriptenModuleConfig,
  HomeMenuProps,
  MenuContentProps,
  NoWasmViewProps,
  PermalinkMenuProps,
  Screen,
  TextMenuProps,
} from "../types";

// Boot Chocolate Doom (classic Emscripten bundle).
//
// The /chocolate-doom.js script auto-runs on load and reads its config from
// the pre-existing global `Module`. The script can only be initialised once
// per page, so a second boot in the same session forces a hard reload — this
// matches the original silentspacemarine.com behaviour.

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
    setScreen({ kind: "game", args: [...COMMON_ARGS] });
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
        <VirtualJoysticks canvasRef={canvasRef} active={false} />
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
      <VirtualJoysticks canvasRef={canvasRef} active={screen.kind === "game"} />
    </>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const NoWasmView: FC<NoWasmViewProps> = ({ footerRef, footerHtml }) => (
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

const HomeMenu: FC<HomeMenuProps> = ({ onSolo, onMultiplayer }) => {
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

const TextMenu: FC<TextMenuProps> = ({ screen }) => {
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

const ChoosePetMenu: FC<ChoosePetMenuProps> = ({
  petName,
  setPetName,
  onSubmit,
}) => {
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
            petName.length ? click("go", () => onSubmit(petName)) : undefined
          }
        >
          Go
        </a>
      </div>
    </div>
  );
};

const DeathmatchOrMenu: FC<DeathmatchOrMenuProps> = ({ onChoice }) => {
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

const PermalinkMenu: FC<PermalinkMenuProps> = ({ room, onStart }) => {
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
  const copyPermalink = () => {
    void navigator.clipboard?.writeText(permalink).catch((err) => {
      console.error("Failed to copy permalink:", err);
    });
  };
  return (
    <div id="text">
      <h1 className="vspace">Doom Multiplayer is about to start</h1>
      <h1 className="vspace">Share this permalink with your friends:</h1>
      <h1>
        <a className="h">{display}</a>
      </h1>
      <h1 className="vspace">Your friends can join until you start the game</h1>
      <h1>Move to next the screen, wait for them, and</h1>
      <h1>then hit space to start the game</h1>
      <h1 />
      <div className="vspace">
        <a
          id="clip"
          className={`btn ${pressed === "clip" ? "grey" : "tertiary"}`}
          data-room={room}
          onClick={click("clip", copyPermalink)}
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
