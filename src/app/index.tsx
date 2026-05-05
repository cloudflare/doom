import "~/index.css";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";

import { Game } from "./Game";

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
