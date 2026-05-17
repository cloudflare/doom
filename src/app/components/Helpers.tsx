import { GameTypewriter } from "./Typewriter";

export const NoWasmView = () => (
  <div id="container">
    <div id="monitor" style={{ display: "block" }}>
      <div id="monitorscreen">
        <div id="menu">
          <div id="logo" />
          <div id="text">
            <h1 className="vspace">Your browser has no WebAssembly Support</h1>
            <h1 className="vspace">
              You need a modern browser to run this demo
            </h1>
          </div>
        </div>
      </div>
      <GameTypewriter />
    </div>
  </div>
);

export const Logo = () => {
  return <div id="logo" />;
};
