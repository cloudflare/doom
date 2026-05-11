import { useEffect, useRef, type FC } from "react";
import type { VirtualJoysticksProps } from "../types";
import * as nipple from "nipplejs";

// ---------------------------------------------------------------------------
// Virtual gamepad keys — match the bindings chocolate-doom listens for in
// default.cfg. We dispatch synthetic KeyboardEvents on `window` because
// SDL2's emscripten port registers its keydown/keyup listener on
// EMSCRIPTEN_EVENT_TARGET_WINDOW by default, and it reads `code` / `key`
// (not the legacy `keyCode`) to build the SDL scancode that chocolate-doom
// looks up in scancode_translate_table (see doom/src/i_input.c).
// ---------------------------------------------------------------------------

// `code` is the physical key (used by SDL for scancode), `key` is the
// produced character (used as a fallback / for charCode).
type Key = { code: string; key: string };

const KEY: Record<string, Key> = {
  left: { code: "ArrowLeft", key: "ArrowLeft" },
  right: { code: "ArrowRight", key: "ArrowRight" },
  down: { code: "ArrowDown", key: "ArrowDown" },
  up: { code: "ArrowUp", key: "ArrowUp" },
  speed: { code: "ShiftLeft", key: "Shift" },
  fire: { code: "Space", key: " " },
  use: { code: "KeyE", key: "e" },
  enter: { code: "Enter", key: "Enter" },
  strafeLeft: { code: "KeyA", key: "a" },
  strafeRight: { code: "KeyD", key: "d" },
};

// Compass quadrant boundaries (in degrees) used to detect diagonals on the
// movement nipple. nipplejs reports an "angle" snapped to one of {left,
// right, up, down}, plus a continuous `degree` we use to add the
// perpendicular key when the stick is in a corner.
const NE = [30, 60] as const;
const NW = [120, 150] as const;
const SW = [210, 240] as const;
const SE = [300, 330] as const;

const isTouch = (): boolean =>
  "ontouchstart" in window ||
  navigator.maxTouchPoints > 0 ||
  // legacy IE
  (navigator as unknown as { msMaxTouchPoints?: number }).msMaxTouchPoints !==
    undefined;

const sendKey = (
  _canvas: HTMLCanvasElement,
  keys: Key[],
  type: "keydown" | "keyup",
): void => {
  for (const k of keys) {
    const ev = new KeyboardEvent(type, {
      code: k.code,
      key: k.key,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
  }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const VirtualJoysticks: FC<VirtualJoysticksProps> = ({
  canvasRef,
  active,
}) => {
  const joy1Ref = useRef<HTMLDivElement>(null);
  const joy2Ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    if (!isTouch()) return;
    const left = joy1Ref.current;
    const right = joy2Ref.current;
    const canvas = canvasRef.current;
    if (!left || !right || !canvas) return;

    const leftJoy = nipple.create({
      zone: left,
      color: "#7d2300",
      mode: "static",
      position: { bottom: "50%", left: "50%" },
    });
    const rightJoy = nipple.create({
      zone: right,
      color: "#7d2300",
      mode: "static",
      position: { bottom: "50%", right: "50%" },
    });

    leftJoy.on("end", (_evt) => {
      console.log("hey")
      sendKey(
        canvas,
        [KEY.left, KEY.right, KEY.down, KEY.up, KEY.speed],
        "keyup",
      );
    });
    leftJoy.on("move", (evt) => {
      console.log("ho")
      const data = evt.data;
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

    rightJoy.on("end", (_evt) => {
      sendKey(
        canvas,
        [KEY.strafeLeft, KEY.strafeRight, KEY.fire, KEY.use, KEY.enter],
        "keyup",
      );
    });
    rightJoy.on("move", (evt) => {
      const data = evt.data;
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
  }, [active, canvasRef]);

  return (
    <>
      <div id="joystick1" ref={joy1Ref} />
      <div id="joystick2" ref={joy2Ref} />
    </>
  );
};

export default VirtualJoysticks;
