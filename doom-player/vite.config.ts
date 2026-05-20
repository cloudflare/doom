import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin reads wrangler.jsonc; the client build's
// fallback is index.html (SPA mode is configured under `assets` in
// wrangler.jsonc).
export default defineConfig({
	plugins: [react(), cloudflare()],
});
