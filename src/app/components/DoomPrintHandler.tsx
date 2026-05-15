import {
  useCallback,
  useRef,
} from "react";
import type { NavigateFunction } from "react-router-dom";
import type { Typewriter } from "../types";
import { ENDPOINTS } from "../lib/tools";

export const useDoomPrintHandler = (
  typewriter: Typewriter,
  room: string,
  navigate: NavigateFunction,
): ((text: string) => void) => {
  // FIFO queue of strings still waiting to be spoken, plus a flag that
  // guarantees only one drain loop runs at a time. Refs (not state) so
  // mutations don't trigger re-renders and the closures below always see
  // the current values.
  const ttsQueue = useRef<string[]>([]);
  const ttsDraining = useRef(false);

  const drainTTS = useCallback(async () => {
    try {
      while (ttsQueue.current.length > 0) {
        const text = ttsQueue.current.shift();
        if (!text) continue;
        try {
          const res = await fetch(`${ENDPOINTS.base}/api/tts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) {
            console.warn(`tts: HTTP ${res.status}`);
            continue;
          }
          const data = (await res.json()) as { audio?: string };
          if (!data.audio) {
            console.warn("tts: no audio in response");
            continue;
          }
          // base64 -> Uint8Array
          const binary = atob(data.audio);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          await new Promise<void>((resolve) => {
            const audio = new Audio(url);
            const cleanup = () => {
              URL.revokeObjectURL(url);
              resolve();
            };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.volume = 0.8;
            audio.play().catch((err) => {
              console.warn("tts: play() rejected", err);
              cleanup();
            });
          });
        } catch (err) {
          console.warn("tts: drain error", err);
        }
      }
    } finally {
      ttsDraining.current = false;
    }
  }, []);

  const enqueueTTS = useCallback(
    (text: string) => {
      ttsQueue.current.push(text);
      if (!ttsDraining.current) {
        ttsDraining.current = true;
        void drainTTS();
      }
    },
    [drainTTS],
  );

  return useCallback(
    (text: string) => {
      if (text.startsWith("doom: ")) {
        const parts = text.slice(6).split(",");
        const idStr = parts[0];
        const rawMsg = parts[1];
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
          case 14: {
            // doom: 14, <player name>, <chat message>
            // Message may itself contain commas, so rejoin the tail.
            const name = (parts[1] ?? "").trim();
            const message = parts.slice(2).join(",").trim();
            if (name || message) {
              enqueueTTS(`${name} says: ${message}`);
            }
            msg = false;
            break;
          }
          default:
            msg = (rawMsg ?? "").trim();
            break;
        }
        if (msg) typewriter(msg);
      }
      console.log(text);
    },
    [typewriter, room, navigate, enqueueTTS],
  );
};
