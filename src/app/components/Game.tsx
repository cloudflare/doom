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
  bootDoom,
  ENDPOINTS,
  COMMON_ARGS,
  ROOM_PATTERN,
} from "../lib/game_tools";
import { VirtualJoysticks } from "./VirtualJoysticks";
import {
  GameFooter,
  useDoomPrintHandler,
  type GameFooterHandle,
  type Typewriter,
} from "./GameFooter";
import { NoWasmView, Logo } from "./Helpers";
import QRCode from "react-qr-code";
import type {
  ChoosePetMenuProps,
  DeathmatchOrMenuProps,
  HomeMenuProps,
  MenuContentProps,
  PermalinkMenuProps,
  Screen,
  TextMenuProps,
} from "../types";

export const Game: FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const footerRef = useRef<GameFooterHandle>(null);

  const [screen, setScreen] = useState<Screen>(() => {
    if (!hasWebAssembly()) return { view: "noWasm" };
    if (isMobile()) return { view: "mobileInfo" };
    if (ROOM_PATTERN.test(location.pathname.replace(/^\//, "")))
      return { view: "validating" };
    return { view: "home" };
  });
  const [petName, setPetName] = useState<string>(() => genPetName());

  const room = useMemo(
    () => location.pathname.replace(/^\//, ""),
    [location.pathname],
  );

  // Stable proxy that forwards messages to <GameFooter>'s imperative API.
  // The footer owns its own message/cycling/animation state internally.
  const typewriter = useCallback<Typewriter>((msg) => {
    footerRef.current?.typewriter(msg);
  }, []);

  // Mobile info screen: show for 5 seconds, then route based on URL.
  useEffect(() => {
    if (screen.view !== "mobileInfo") return;
    const t = window.setTimeout(() => {
      const path = location.pathname.replace(/^\//, "");
      setScreen(
        ROOM_PATTERN.test(path) ? { view: "validating" } : { view: "home" },
      );
    }, 5000);
    return () => window.clearTimeout(t);
  }, [screen.view, location.pathname]);

  // Validate room when entering a multiplayer URL.
  useEffect(() => {
    if (screen.view !== "validating") return;
    typewriter('<h1 class="vspace">Validating room...</h1>');
    let cancelled = false;
    void fetch(`${ENDPOINTS.base}/api/room/${room}`)
      .then((r) => r.json())
      .then((data: { room?: string; gameStarted?: boolean }) => {
        if (cancelled) return;
        if (!data.room) {
          setScreen({ view: "invalid" });
          return;
        }
        if (data.gameStarted) {
          setScreen({ view: "tooLate" });
          return;
        }
        // Small delay to mimic the previous setTimeout(... 3000).
        window.setTimeout(() => {
          if (cancelled) return;
          setScreen({ view: "choosePet", mode: "join", room });
        }, 3000);
      })
      .catch(() => {
        if (!cancelled) setScreen({ view: "invalid" });
      });
    return () => {
      cancelled = true;
    };
  }, [screen.view, room, typewriter]);

  // Auto-redirects for terminal info screens.
  useEffect(() => {
    if (screen.view === "invalid") {
      const t = window.setTimeout(() => navigate("/", { replace: true }), 3000);
      return () => window.clearTimeout(t);
    }
    if (screen.view === "tooLate") {
      const t = window.setTimeout(() => navigate("/", { replace: true }), 7000);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [screen.view, navigate]);

  // Disable pinch-to-zoom on iOS (matches the original `gesturestart` hack).
  useEffect(() => {
    const stopGesture = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", stopGesture);
    return () => document.removeEventListener("gesturestart", stopGesture);
  }, []);

  // chocolate-doom's `print` callback. The doom-specific message decoding
  // lives alongside <GameFooter> in ./GameFooter so this component stays
  // focused on screen routing.
  const handlePrint = useDoomPrintHandler(typewriter, room, navigate);

  // Boot the WASM module when entering the "game" screen.
  useEffect(() => {
    if (screen.view !== "game") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onContextLost = (e: Event) => {
      window.alert("WebGL context lost. You will need to reload the page.");
      e.preventDefault();
    };
    canvas.addEventListener("webglcontextlost", onContextLost, false);

    void bootDoom(screen.args, canvas, handlePrint).catch((err) => {
      console.error(err);
    });

    return () => {
      canvas.removeEventListener("webglcontextlost", onContextLost, false);
    };
    // We deliberately depend on screen reference; args are stable per game.
  }, [screen, handlePrint]);

  // Screen-specific transitions
  const startSolo = useCallback(() => {
    typewriter([
      "W,A,S,D OR ARROWS TO MOVE, Q,E,Z|O TO STRAFE, X|P FOR SPEED, C TO OPEN",
      "TAB SHOWS THE MAP, T TO WRITE (MULTIPLAYER), YOU CAN ALSO USE THE MOUSE",
    ]);
    setScreen({ view: "game", args: [...COMMON_ARGS] });
  }, [typewriter]);

  const startMultiplayer = useCallback(() => {
    void fetch(`${ENDPOINTS.base}/api/newroom`)
      .then((r) => r.json())
      .then((data: { room: string }) => {
        setScreen({ view: "choosePet", mode: "host", room: data.room });
      });
  }, []);

  const onChoosePetSubmit = useCallback(
    (s: Screen & { view: "choosePet" }) => (pet: string) => {
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
        setScreen({ view: "game", args });
      } else if (s.mode === "host" && s.room) {
        setScreen({ view: "deathmatchOr", pet: trimmed, room: s.room });
      }
    },
    [typewriter],
  );

  const onDeathmatchChoice = useCallback(
    (s: Screen & { view: "deathmatchOr" }) => (deathmatch: boolean) => {
      const args = [
        ...COMMON_ARGS,
        "-pet",
        s.pet,
        ...(deathmatch ? ["-deathmatch"] : []),
      ];
      setScreen({ view: "permalink", room: s.room, args });
    },
    [],
  );

  const onPermalinkStart = useCallback(
    (s: Screen & { view: "permalink" }) => () => {
      const args = [
        ...s.args,
        "-server",
        "-privateserver",
        "-dup",
        "1",
        "-wss",
        `${ENDPOINTS.wsbase}/api/ws/${s.room}`,
      ];
      setScreen({ view: "game", args });
    },
    [],
  );

  if (screen.view === "noWasm") {
    return <NoWasmView />;
  }

  if (screen.view === "mobileInfo") {
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
              style={{ display: screen.view === "game" ? "" : "none" }}
            />
            {screen.view !== "game" && (
              <div id="menu">
                <Logo screen={screen} />
                <MenuContent
                  screen={screen}
                  petName={petName}
                  setPetName={setPetName}
                  onSolo={startSolo}
                  onMultiplayer={startMultiplayer}
                  onChoosePetSubmit={
                    screen.view === "choosePet"
                      ? onChoosePetSubmit(screen)
                      : undefined
                  }
                  onDeathmatchChoice={
                    screen.view === "deathmatchOr"
                      ? onDeathmatchChoice(screen)
                      : undefined
                  }
                  onPermalinkStart={
                    screen.view === "permalink"
                      ? onPermalinkStart(screen)
                      : undefined
                  }
                />
              </div>
            )}
          </div>
          <GameFooter ref={footerRef} />
        </div>
      </div>
      <VirtualJoysticks canvasRef={canvasRef} active={screen.view === "game"} />
    </>
  );
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
  switch (screen.view) {
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
  if (screen.view === "validating") {
    return (
      <div id="text">
        <h1 className="vspace">Validating room...</h1>
      </div>
    );
  }
  if (screen.view === "tooLate") {
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
  const [qr, setQr] = useState(false);
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
      {!qr ? (
        <>
          <h1 className="vspace">Doom Multiplayer is about to start</h1>
          <h1 className="vspace">Share this permalink with your friends:</h1>
          <h1>
            <a className="h">{display}</a>
          </h1>
        </>
      ) : (
        <QRCode value={permalink} />
      )}
      <h1 className="vspace">Your friends can join until you start the game</h1>
      <h1>Move to next the screen, wait for them, and</h1>
      <h1>then hit space to start the game</h1>
      <h1 />
      <div className="vspace">
        <a
          id="clip"
          className={`btn ${pressed === "clip" ? "grey" : "primary"}`}
          data-room={room}
          onClick={click("clip", copyPermalink)}
        >
          Copy Permalink
        </a>
        <a
          id="clip"
          className={`btn ${pressed === "clip" ? "grey" : "tertiary"}`}
          data-room={room}
          onClick={() => {
            setQr(!qr);
          }}
        >
          {qr ? `Hide QR Code` : `Show QR Code`}{" "}
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
