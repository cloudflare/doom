import { useCallback, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { Typewriter } from "../types";
import { ENDPOINTS } from "../lib/tools";

export const useDoomPrintHandler = (
  typewriter: Typewriter,
  room: string,
  navigate: NavigateFunction,
): ((text: string) => void) => {
  // FIFO queue of items still waiting to be spoken
  const ttsQueue = useRef<{ text: string; cache: boolean }[]>([]);
  const ttsDraining = useRef(false);
  // Dedupe identical TTS requests fired within a short window.
  const ttsLastText = useRef<string | null>(null);
  const ttsLastAt = useRef(0);
  const TTS_DEDUPE_WINDOW_MS = 4000;
  // Client-side cache of synthesised MP3 blobs keyed by source text.
  const ttsCache = useRef<Map<string, Blob>>(new Map());
  const TTS_CACHE_MAX_ENTRIES = 64;

  const drainTTS = useCallback(async () => {
    try {
      while (ttsQueue.current.length > 0) {
        const item = ttsQueue.current.shift();
        if (!item) continue;
        const { text, cache } = item;
        try {
          let blob: Blob | undefined = ttsCache.current.get(text);
          if (!blob) {
            const res = await fetch(`${ENDPOINTS.base}/api/tts`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text }),
            });
            if (!res.ok) {
              console.warn(`tts: HTTP ${res.status}`);
              continue;
            }
            // Worker streams MP3 bytes back (Workers AI ReadableStream
            // piped through). Consume as a Blob and play it directly.
            const audioBlob = await res.blob();
            if (audioBlob.size === 0) {
              console.warn("tts: empty audio response");
              continue;
            }
            blob =
              audioBlob.type && audioBlob.type !== ""
                ? audioBlob
                : new Blob([audioBlob], { type: "audio/mpeg" });
            if (cache) {
              // FIFO eviction once we hit the cap.
              if (ttsCache.current.size >= TTS_CACHE_MAX_ENTRIES) {
                const oldest = ttsCache.current.keys().next().value;
                if (oldest !== undefined) ttsCache.current.delete(oldest);
              }
              ttsCache.current.set(text, blob);
            }
          } else {
            console.log(`using Workers AI cache for ${text}`);
          }
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
    (text: string, cache: boolean = false) => {
      const now = Date.now();
      if (
        ttsLastText.current === text &&
        now - ttsLastAt.current < TTS_DEDUPE_WINDOW_MS
      ) {
        // Same text fired again within the dedupe window -- ignore the
        // repeat and refresh the timestamp so a steady stream of repeats
        // keeps the suppression alive.
        ttsLastAt.current = now;
        return;
      }
      ttsLastText.current = text;
      ttsLastAt.current = now;
      ttsQueue.current.push({ text, cache });
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
          case 15: {
            // doom: 15, <system message>
            // Message may itself contain commas, so rejoin the tail.
            const sys = parts.slice(1).join(",").trim();
            if (sys) {
              enqueueTTS(sys, true);
            }
            msg = false;
            break;
          }
          case 16:
            // doom: 16, game quit -- the WASM runtime is tearing itself
            // down via emscripten_force_exit() right after emitting this.
            // Both `/` and `/:room` render the same <Game/>, so a plain
            // navigate() would keep the existing component mounted with
            // stale (now-dead) state. Force a full page reload to `/` so
            // React, the canvas, and any sockets reset cleanly.
            msg = false;
            window.location.replace("/");
            break;
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
