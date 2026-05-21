/**
 * Helpers for unwrapping payloads returned by WebMCP tools.
 *
 * The doom page's tools (and most MCP-style tools in general) return
 * results in a nested envelope:
 *
 *   { content: [ { type: "text", text: "<json-or-plain-text>" } ] }
 *
 * Sometimes that envelope is wrapped a second time -- the polyfill or
 * the CDP transport can introduce its own layer. And sometimes the
 * envelope carries `isError: true` to signal an engine-side problem
 * (e.g. "Doom module not initialised yet"). Consumers need to:
 *
 *   1. Peel as many envelope layers as exist, recursively.
 *   2. Recognise `isError: true` payloads and surface their text as
 *      an engine error.
 *   3. Return the innermost text so the caller can parse it as JSON
 *      (or use it directly if the tool returns plain text).
 *
 * Both `src/player.ts` (deterministic player) and
 * `src/bot/context.ts` (user-bot helper) need this exact behaviour;
 * keeping the algorithm in one place prevents drift -- the player's
 * forgiving recursive unwrapper and the bot's strict one-shot
 * unwrapper had already diverged once and that divergence caused
 * silent bot failures.
 */

import type { InvokeResult } from "./webmcp";

/** Engine returned `isError: true` with a human-readable message. */
export class McpEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpEngineError";
  }
}

/**
 * Peel zero-or-more `{content:[{type:"text", text}]}` layers from
 * `value`, returning the innermost text. If any layer carries
 * `isError: true`, throws `McpEngineError` with that layer's text.
 *
 * If the value cannot be unwrapped to a string (e.g. the tool
 * returned a structured object directly, not an MCP envelope),
 * returns `null`. Callers should treat that as "this wasn't a text
 * payload" and fall back to whatever shape they were expecting.
 */
export function peelTextEnvelope(value: unknown): string | null {
  let current: unknown = value;

  // Bound the loop in case of pathological input; in practice we
  // expect at most 2 layers.
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current === "string") return current;
    if (!current || typeof current !== "object") return null;

    const obj = current as { isError?: unknown; content?: unknown };

    if (obj.isError === true) {
      // Surface the inner text (if any) as an explicit engine
      // error. Callers turn this into a useful diagnostic.
      const text = firstTextItem(obj.content);
      throw new McpEngineError(
        text ?? "engine returned an unstructured error",
      );
    }

    const text = firstTextItem(obj.content);
    if (text === null) {
      // No `content[0].text` field to descend into.
      return null;
    }

    // The text might be another JSON-encoded envelope; if it parses
    // and the parsed object looks like one, descend.
    try {
      const parsed: unknown = JSON.parse(text);
      if (looksLikeEnvelope(parsed)) {
        current = parsed;
        continue;
      }
    } catch {
      // Not JSON; treat as the innermost payload.
    }

    return text;
  }

  return null;
}

function firstTextItem(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  return first.text;
}

function looksLikeEnvelope(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    "content" in (v as Record<string, unknown>) &&
    Array.isArray((v as { content?: unknown }).content)
  );
}

/**
 * Convenience: take an InvokeResult and pull the innermost text out
 * of its `output` field. Returns `null` if there's no text (e.g. the
 * tool returned a structured object) or the InvokeResult itself is
 * an error. Throws `McpEngineError` if the engine surfaced an
 * `isError: true` envelope.
 */
export function extractTextFromInvokeResult(
  result: InvokeResult,
): string | null {
  if (result.status !== "Completed") return null;
  return peelTextEnvelope(result.output);
}
