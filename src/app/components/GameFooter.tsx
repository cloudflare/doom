import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FC,
  type Ref,
} from "react";
import type { NavigateFunction } from "react-router-dom";
import { ENDPOINTS } from "../lib/game_tools";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// `typewriter()` replaces a single message or rotates through an array of
// messages on the in-game footer. The previous animation is restarted each
// time it's invoked.
export type Typewriter = (msg: string | string[]) => void;

// Imperative handle exposed by <GameFooter ref={…} />.
export type GameFooterHandle = {
  typewriter: Typewriter;
};

type GameFooterProps = {
  ref?: Ref<GameFooterHandle>;
};

// ---------------------------------------------------------------------------
// Component
//
// Owns the footer's local state (current message list + active index), the
// 10s message-cycling timer, and the CSS "writer" animation re-trigger. The
// parent talks to it through an imperative `typewriter()` handle so callers
// don't have to know the footer exists at all — they just call
// `footerRef.current?.typewriter(...)` whenever they have something to say.
// ---------------------------------------------------------------------------

export const GameFooter: FC<GameFooterProps> = ({ ref }) => {
  const footerRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [index, setIndex] = useState<number>(0);

  const typewriter = useCallback<Typewriter>((msg) => {
    setMessages(Array.isArray(msg) ? msg : [msg]);
    setIndex(0);
  }, []);

  useImperativeHandle(ref, () => ({ typewriter }), [typewriter]);

  // Rotate through messages every 10s when there's more than one.
  useEffect(() => {
    if (messages.length <= 1) return;
    const t = window.setTimeout(() => {
      setIndex((i) => (i + 1) % messages.length);
    }, 10000);
    return () => window.clearTimeout(t);
  }, [messages, index]);

  // Restart the CSS "writer" animation on each footer update by toggling the
  // class and forcing a reflow in between.
  useEffect(() => {
    const f = footerRef.current;
    if (!f) return;
    f.classList.remove("writer");
    // force reflow so the animation restarts
    void f.offsetWidth;
    f.classList.add("writer");
  }, [messages, index]);

  return (
    <div
      id="footer"
      ref={footerRef}
      className="writer"
      dangerouslySetInnerHTML={{ __html: messages[index] ?? "" }}
    />
  );
};

GameFooter.displayName = "GameFooter";

// ---------------------------------------------------------------------------
// useDoomPrintHandler
//
// Returns the `print` callback we hand to chocolate-doom's Emscripten module.
// Lives next to <GameFooter> because its only side-effect is to drive the
// footer's typewriter (plus a couple of router/API calls keyed off doom's
// numeric status codes).
// ---------------------------------------------------------------------------

export const useDoomPrintHandler = (
  typewriter: Typewriter,
  room: string,
  navigate: NavigateFunction,
): ((text: string) => void) =>
  useCallback(
    (text: string) => {
      if (text.startsWith("doom: ")) {
        const [idStr, rawMsg] = text.slice(6).split(",");
        const id = Number.parseInt(idStr ?? "", 10);
        let msg: string | string[] | false = rawMsg ?? "";
        switch (id) {
          case 2:
            msg = [
              "Connected to Cloudflare Server. Waiting for other players",
              "Still here, waiting for the host to start the game",
              "Note that new players can't join after the host starts the game",
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
          case 13:
            msg = ["THE HOST DISCONNECTED, WE HAVE NO SERVER"];
            break;
          default:
            msg = (rawMsg ?? "").trim();
            break;
        }
        if (msg) typewriter(msg);
      }
      console.log(text);
    },
    [typewriter, room, navigate],
  );
