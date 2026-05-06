import { useEffect, useRef, type FC } from "react";
import type { VirtualJoysticksProps } from "../types";

// ---------------------------------------------------------------------------
// Virtual gamepad keycodes — match the bindings chocolate-doom listens for
// in default.cfg. We dispatch synthetic keydown/keyup events on the canvas
// because the WASM build reads input through the SDL event loop, which is
// fed by DOM events on the canvas element.
// ---------------------------------------------------------------------------

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
  }, [active, canvasRef]);

  return (
    <>
      <div id="joystick1" ref={joy1Ref} />
      <div id="joystick2" ref={joy2Ref} />
    </>
  );
};

export default VirtualJoysticks;
