import { type FC } from "react";
import { GameFooter } from "./GameFooter";
import type { LogoProps } from "../types";

export const NoWasmView: FC = () => (
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
      <GameFooter />
    </div>
  </div>
);

export const Logo: FC<LogoProps> = ({ screen }) => {
  const showLogo =
    screen.view === "home" ||
    screen.view === "validating" ||
    screen.view === "tooLate" ||
    screen.view === "choosePet" ||
    screen.view === "deathmatchOr";
  return (
    <div
      id="logo"
      className="vspace"
      style={{ display: showLogo ? "" : "none" }}
    />
  );
};
