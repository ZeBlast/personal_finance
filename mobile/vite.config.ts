import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The phone viewer's web part. `npm run dev -w mobile` serves it in a browser with a stand-in for
// the phone's native features (see src/native.ts); `npm run sync -w mobile` builds it into the
// Android project. Relative paths: the Android WebView loads the files from the app itself.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1430, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
