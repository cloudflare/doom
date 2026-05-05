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

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src/app"),
      "~lib": path.resolve(__dirname, "./lib"),
    },
  },
  plugins: [
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
