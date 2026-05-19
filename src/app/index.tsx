import "~/styles.css";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";

import { Game } from "./components/Game";
import { initWebMCP } from "./lib/webmcp";

// Install navigator.modelContext for AI agents. Tools are registered
// per-screen inside <Game />.
initWebMCP();

const NotFound = () => {
  return (
    <>
      <p>404 - not found</p>
    </>
  );
};

const Root = () => {
  return (
    <>
      <video
        className="bg-video"
        src="https://workers.cloudflare.com/static/hero-background-video.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden
      />
      <Outlet />
    </>
  );
};

const routes = [
  {
    path: "/",
    element: <Root />,
    errorElement: <NotFound />,
    children: [
      {
        index: true,
        element: <Game />,
      },
      {
        // Multiplayer permalinks of the form `/<adj>-<noun>`.
        path: ":room",
        element: <Game />,
      },
    ],
  },
];

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);
root.render(<RouterProvider router={createBrowserRouter(routes)} />);
