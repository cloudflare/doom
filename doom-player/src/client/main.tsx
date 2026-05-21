import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
