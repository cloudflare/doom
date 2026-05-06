import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import chalk from "chalk";
import fs from "node:fs";
import dotenv from "dotenv";

// Load .dev.vars (wrangler convention) as fallbacks for process.env
if (fs.existsSync(".dev.vars")) {
  const devVars = dotenv.parse(fs.readFileSync(".dev.vars", "utf-8"));
  for (const [k, v] of Object.entries(devVars)) {
    process.env[k] ??= v;
  }
}

// Vite's bundled `mrmime` MIME table doesn't know `.cfg` or `.wad`, so its
// dev-server static middleware serves `public/default.cfg` and
// `public/doom1.wad` with an empty `Content-Type:` header. Chromium tolerates
// that; WebKit (Safari) rejects the response and the chocolate-doom Emscripten
// preload (`createPreloadedFile`) then can't fetch them, which manifests as
// "An error occurred trying to load the resource." in the Network panel.
// We pre-empt Vite's static handler for these two extensions and stream the
// file with an explicit, correct Content-Type.
const PUBLIC_DIR = path.resolve(__dirname, "public");
const EXTRA_MIME: Record<string, string> = {
  ".cfg": "text/plain; charset=utf-8",
  ".wad": "application/octet-stream",
};

// We need this because
// Safari/WebKit refuses responses with empty Content-Type (Chromium browsers tolerates them)
const injectMime = {
  name: "inject-mime",
  // Run only on the dev server; build/preview use sirv config or Workers
  // Assets which have their own MIME handling.
  apply: "serve" as const,
  // Order before Vite's internal static-serve middleware.
  enforce: "pre" as const,
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      const urlPath = (req.url ?? "").split("?")[0];
      const ext = path.extname(urlPath).toLowerCase();
      const mime = EXTRA_MIME[ext];
      if (!mime) return next();
      // Resolve safely inside public/ to prevent path traversal.
      const filePath = path.join(PUBLIC_DIR, urlPath);
      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return next();
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return next();
      }
      if (!stat.isFile()) return next();
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Accept-Ranges", "bytes");

      // Honour byte-range requests so Safari (which sometimes range-fetches
      // even for fetch()/XHR-loaded binaries) gets a well-formed 206 response
      // instead of a full 200 it didn't ask for.
      const rangeHeader = req.headers.range;
      const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
      if (rangeMatch) {
        const startStr = rangeMatch[1];
        const endStr = rangeMatch[2];
        const total = stat.size;
        let start = startStr === "" ? NaN : Number(startStr);
        let end = endStr === "" ? total - 1 : Number(endStr);
        if (startStr === "" && endStr !== "") {
          // suffix range: bytes=-N → last N bytes
          start = Math.max(0, total - Number(endStr));
          end = total - 1;
        }
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end >= total ||
          start > end
        ) {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${total}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", end - start + 1);
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }

      res.setHeader("Content-Length", stat.size);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  },
};

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src/app"),
      "~lib": path.resolve(__dirname, "./lib"),
    },
  },
  plugins: [
    injectMime,
    react(),
    cloudflare(),
    tailwindcss(),
    {
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const timeString = new Date().toLocaleTimeString();
          console.log(
            `[${chalk.blue(timeString)}] ${chalk.green(
              req.method,
            )} ${chalk.yellow(req.url)}`,
          );
          next();
        });
      },
      name: "requestLogger",
    },
  ],
});
