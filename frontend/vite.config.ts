import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Development in a plain browser tab: `npm run dev:backend` and `npm run dev:frontend`, then open
// http://127.0.0.1:1420. The page is served by Vite (hot reload) and /api is forwarded to the
// backend, with the dev token added, so no cookie or Tauri window is needed. The installed app
// never uses this.
const backend = `http://127.0.0.1:${process.env["PF_PORT"] ?? "47831"}`;

// Tauri's dev window loads this fixed address (see src-tauri/tauri.conf.json devUrl).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        headers: { "x-pf-token": process.env["PF_TOKEN"] ?? "dev-token" },
      },
    },
  },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
