import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  hasWebAssembly,
  isMobile,
  genPetName,
  bootDoom,
  ENDPOINTS,
  COMMON_ARGS,
  IWADS,
  ROOM_PATTERN,
} from "../lib/game_tools";
import { VirtualJoysticks } from "./VirtualJoysticks";
import { useDownloadProgress, DownloadProgress } from "./ProgressBar";
import {
  GameFooter,
  useDoomPrintHandler,
  type GameFooterHandle,
  type Typewriter,
} from "./GameFooter";
import { NoWasmView, Logo } from "./Helpers";
import QRCode from "react-qr-code";

const Monitor = ({
  children,
  canvasRef,
  footerRef,
  joysticksActive,
}: {
  children: ReactNode;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  footerRef: RefObject<GameFooterHandle | null>;
  joysticksActive: boolean;
}) => {
  return (
    <>
      <div id="container">
        <div id="monitor" style={{ display: "block" }}>
          <div id="monitorscreen">{children}</div>
          <GameFooter ref={footerRef} />
        </div>
      </div>
      <VirtualJoysticks canvasRef={canvasRef} active={joysticksActive} />
    </>
  );
};

export const Game = () => {
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const footerRef = useRef(null);
  const [multiplayer, setMultiplayer] = useState(false);
  const [pet, setPet] = useState("");
  const [error, setError] = useState("");
  const [room, setRoom] = useState("");
  const [type, setType] = useState("");
  const [iwad, setIwad] = useState("");
  const [host, setHost] = useState(true);

  const homeOrJoin = () => {
    if (ROOM_PATTERN.test(location.pathname.replace(/^\//, "")))
      return "validating";
    return "home";
  };

  const [view, setView] = useState(() => {
    if (!hasWebAssembly()) return "noWasm";
    if (isMobile()) return "mobileInfo";
    return homeOrJoin();
  });

  const typewriter = useCallback<Typewriter>((msg) => {
    footerRef.current?.typewriter(msg);
  }, []);
  const handlePrint = useDoomPrintHandler(typewriter, room, navigate);

  const {
    onProgress: handleDownloadProgress,
    totalPercent,
    allDone: downloadsDone,
    hasTotals,
    totalLoaded,
    totalTotal,
  } = useDownloadProgress();

  const showError = (msg: string) => {
    setError(msg);
    setView("error");
  };

  useEffect(() => {
    switch (view) {
      case "validating":
        fetch(
          `${ENDPOINTS.base}/api/room/${location.pathname.replace(/^\//, "") ?? ""}`,
        )
          .then((r) => r.json())
          .then((data) => {
            console.log(data);
            if (!data.room) {
              showError("Invalid room");
              return;
            }
            if (data.gameStarted) {
              showError("Game has already started, too late.");
              return;
            }
            setIwad(data.iwad);
            setRoom(data.room);
            setType(data.type);
            setMultiplayer(true);
            setHost(false);
            setView(data.serverReady ? "pet" : "waitingForHost");
          })
          .catch(() => {});
        break;
      case "waitingForHost": {
        const room = location.pathname.replace(/^\//, "");
        const interval = setInterval(() => {
          fetch(`${ENDPOINTS.base}/api/room/${room}`)
            .then((r) => r.json())
            .then((data) => {
              if (!data.room) {
                showError("Invalid room");
                return;
              }
              if (data.gameStarted) {
                showError("Game has already started, too late.");
                return;
              }
              if (data.gameEnded) {
                showError("Game has already ended, too late.");
                return;
              }
              if (data.serverReady) {
                setView("pet");
              }
            })
            .catch(() => {});
        }, 1500);
        return () => clearInterval(interval);
      }
      case "game":
        let xtra_args = [];
        if (iwad) {
          if (multiplayer) {
            xtra_args = [
              "-pet",
              pet,
              "-dup",
              "1",
              "-wss",
              `${ENDPOINTS.wsbase}/api/ws/${room}/host`,
            ];
            if (type == "deathmatch") {
              xtra_args = [...xtra_args, "-deathmatch"];
            }
            if (host) {
              xtra_args = [...xtra_args, "-server", "-privateserver"];
            } else {
              xtra_args = [...xtra_args, "-connect", "1"];
            }
          }
          const args = [
            ...COMMON_ARGS,
            "-iwad",
            IWADS[iwad].file,
            ...xtra_args,
          ];
          bootDoom(
            args,
            canvasRef.current,
            handlePrint,
            iwad,
            handleDownloadProgress,
          ).catch((err) => {
            console.log(err);
            showError(err.toString());
          });
        }
    }
  }, [view]);

  const monitorProps = {
    canvasRef,
    footerRef,
    joysticksActive: view === "game",
  };

  switch (view) {
    case "noWasm":
      return <NoWasmView />;
    case "mobileInfo":
      return (
        <>
          <div id="container">
            <div id="mobile" style={{ display: "block" }}>
              <h1>
                For a better mobile experience, click "Hide Toolbar" in the URL
                toolbar
              </h1>
              <img
                src="hidetoolbar.png"
                alt="hide toolbar"
                onClick={() => {
                  setView(homeOrJoin());
                }}
              />
              <a
                className="btn primary"
                id="solo"
                onClick={() => {
                  setView(homeOrJoin());
                }}
              >
                Start
              </a>
            </div>
          </div>
        </>
      );
    case "iwad":
      return (
        <Monitor {...monitorProps}>
          <Logo />
          <ChooseMap
            onSubmit={(iwad: string) => {
              setIwad(iwad);
              if (multiplayer) {
                setView("pet");
              } else {
                setView("game");
              }
            }}
          />
        </Monitor>
      );
    case "pet":
      return (
        <Monitor {...monitorProps}>
          <Logo />
          <ChoosePet
            onSubmit={(pet: string) => {
              setPet(pet);
              if (room.length) {
                setView("game");
              } else {
                setView("type-of-game");
              }
            }}
          />
        </Monitor>
      );
    case "type-of-game":
      return (
        <Monitor {...monitorProps}>
          <Logo />
          <TypeOfGame
            onSubmit={(type: string) => {
              setType(type);
              setView("permalink");
            }}
          />
        </Monitor>
      );
    case "permalink":
      return (
        <Monitor {...monitorProps}>
          <Permalink
            iwad={iwad}
            type={type}
            onStart={(room: string) => {
              setRoom(room);
              setView("game");
            }}
          />
        </Monitor>
      );
    case "validating":
      return (
        <Monitor {...monitorProps}>
          <Logo />
          <div id="text">
            <h1 className="vspace">Validating room...</h1>
          </div>
        </Monitor>
      );
    case "waitingForHost":
      return (
        <Monitor {...monitorProps}>
          <Logo />
          <div id="text">
            <h1 className="vspace">
              Waiting for the host to start the game...
            </h1>
            <h1>Hang tight — this screen will advance automatically</h1>
          </div>
        </Monitor>
      );
    case "error":
      return (
        <Monitor {...monitorProps}>
          <Logo />
          <div id="text">
            <h1 className="vspace">{error}</h1>
          </div>
        </Monitor>
      );
    case "game":
      return (
        <Monitor {...monitorProps}>
          {/* Canvas is always mounted AND visible from the very first render
              so SDL_CreateWindow (called during chocolate-doom's startup) can
              measure its computed dimensions from the surrounding
              #monitorscreen layout. Hiding it with `display: none` causes SDL
              to capture a 0x0 framebuffer and the game renders nothing even
              after the canvas is later revealed. The DownloadProgress
              component sits on top as an absolutely-positioned overlay (see
              ProgressBar.tsx) while the WAD streams in. */}
          <canvas
            id="canvas"
            ref={canvasRef}
            onContextMenu={(e) => e.preventDefault()}
            tabIndex={-1}
            style={{ display: view === "game" ? "" : "none" }}
          />
          {!downloadsDone && (
            <DownloadProgress
              iwadLabel={IWADS[iwad]?.label ?? "Doom"}
              totalPercent={totalPercent}
              hasTotals={hasTotals}
              totalLoaded={totalLoaded}
              totalTotal={totalTotal}
            />
          )}
        </Monitor>
      );
    default:
      return (
        <Monitor {...monitorProps}>
          <Logo />
          <Home
            onSubmit={(multiplayer: boolean) => {
              setMultiplayer(multiplayer);
              setView("iwad");
            }}
          />
        </Monitor>
      );
  }
};

const Home = ({ onSubmit }) => {
  return (
    <>
      <div id="buttons">
        <a
          className="btn secondary"
          id="multiplayer"
          onClick={() => {
            onSubmit(true);
          }}
        >
          Start Multiplayer
        </a>
        <a
          className="btn primary"
          id="solo"
          onClick={() => {
            onSubmit(false);
          }}
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

const ChooseMap = ({ onSubmit }) => {
  return (
    <div id="text">
      <h1 className="vspace">Choose which IWAD to play</h1>
      <a className="btn primary" onClick={() => onSubmit("doom1")}>
        {IWADS.doom1.label}
      </a>
      <a className="btn secondary" onClick={() => onSubmit("doom2")}>
        {IWADS.doom2.label}
      </a>
    </div>
  );
};

const ChoosePet = ({ onSubmit }) => {
  const [petName, setPetName] = useState(genPetName());
  return (
    <div id="text">
      <h1 className="vspace">The host is about to start the game</h1>
      <h1>Name your pet here</h1>
      <div className="pinput">
        <a
          className="btn tertiary"
          id="random"
          onClick={() => setPetName(genPetName())}
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
          className="btn secondary"
          id="mypet"
          onClick={petName.length ? () => onSubmit(petName) : undefined}
        >
          Go
        </a>
      </div>
    </div>
  );
};

const TypeOfGame = ({ onSubmit }) => {
  return (
    <div id="text">
      <h1 className="vspace">Chose the type of multiplayer game</h1>
      <a
        className="btn secondary"
        id="deathmatch"
        onClick={() => onSubmit("deathmatch")}
      >
        Deathmatch
      </a>
      <a
        className="btn primary"
        id="cooperative"
        onClick={() => onSubmit("cooperative")}
      >
        Cooperative
      </a>
    </div>
  );
};

const Permalink = ({ onStart, iwad, type }) => {
  const navigate = useNavigate();
  const [room, setRoom] = useState("");
  const permalink = `${ENDPOINTS.web}/${room}`;
  const copyPermalink = () => {
    void navigator.clipboard?.writeText(permalink).catch((err) => {
      console.error("Failed to copy permalink:", err);
    });
  };

  useEffect(() => {
    void fetch(`${ENDPOINTS.base}/api/newroom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ iwad, type }),
    })
      .then((r) => r.json())
      .then((data: { room: string }) => {
        navigate(`/${room}`);
        setRoom(data.room);
      });
  }, [iwad, type]);

  return (
    <div id="text">
      {room.length && <QRCode value={permalink} />}
      <h1 className="vspace">Share the link or the QRCode with your friends</h1>
      <h1>Players can join until you start the game</h1>
      <h1>Move to next the screen, wait for them, and</h1>
      <h1>then hit space to start the game</h1>
      <h1 />
      <div className="vspace">
        <a
          id="clip"
          className="btn primary"
          data-room={room}
          onClick={copyPermalink}
        >
          Copy Permalink
        </a>
        <a
          className="btn secondary"
          id="start"
          data-room={room}
          onClick={() => onStart(room)}
        >
          Next
        </a>
      </div>
    </div>
  );
};

export default Game;
