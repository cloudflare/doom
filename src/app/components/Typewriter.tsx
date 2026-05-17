import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FC,
  type Ref,
} from "react";
import type { Typewriter } from "../types";

// Imperative handle exposed by <GameTypewriter ref={…} />.
export type GameTypewriterHandle = {
  typewriter: Typewriter;
};

type GameTypewriterProps = {
  ref?: Ref<GameTypewriterHandle>;
};

export const GameTypewriter: FC<GameTypewriterProps> = ({ ref }) => {
  const typewriterRef = useRef<HTMLDivElement>(null);
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

  // Restart the CSS "writer" animation on each typewriter  update by toggling the
  // class and forcing a reflow in between.
  useEffect(() => {
    const f = typewriterRef.current;
    if (!f) return;
    f.classList.remove("writer");
    // force reflow so the animation restarts
    void f.offsetWidth;
    f.classList.add("writer");
  }, [messages, index]);

  return (
    <div
      id="typewriter"
      ref={typewriterRef}
      className="writer"
      dangerouslySetInnerHTML={{ __html: messages[index] ?? "" }}
    />
  );
};

GameTypewriter.displayName = "GameTypewriter";
