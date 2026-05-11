import { GameFooter } from "./GameFooter";

export const NoWasmView = () => (
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

export const Logo = () => {
  return <div id="logo" className="vspace" />;
};
