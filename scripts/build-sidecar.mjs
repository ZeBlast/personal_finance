// Builds the backend into a single executable that Tauri runs as a sidecar.
//
//   backend/src/server.ts --esbuild--> build/server.cjs --Node SEA--> src-tauri/binaries/backend-<triple>.exe
//
// It also copies the better-sqlite3-multiple-ciphers native add-on to src-tauri/resources/native/, because a Node
// single-executable app cannot embed native add-ons; the backend loads it with process.dlopen.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const binariesDir = join(root, "src-tauri", "binaries");
const nativeDir = join(root, "src-tauri", "resources", "native");

// Tauri expects sidecars to be named <name>-<rust target triple>.exe
const hostLine = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((line) => line.startsWith("host:"));
if (!hostLine) throw new Error("Could not determine the Rust target triple (is Rust installed?)");
const triple = hostLine.replace("host:", "").trim();
if (triple !== "x86_64-pc-windows-msvc") {
  throw new Error(`Only x86_64-pc-windows-msvc is wired up so far (found ${triple})`);
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(binariesDir, { recursive: true });
mkdirSync(nativeDir, { recursive: true });

// 1. Bundle the backend (and all its JavaScript dependencies) into one CommonJS file.
await build({
  entryPoints: [join(root, "backend", "src", "server.ts")],
  outfile: join(buildDir, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
});

// 2. Turn it into a single-executable blob.
const seaConfig = join(buildDir, "sea-config.json");
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: join(buildDir, "server.cjs"),
    output: join(buildDir, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. Copy node.exe and inject the blob. The sentinel string differs between Node versions, so
//    read it from the binary instead of hard-coding it.
const outExe = join(binariesDir, `backend-${triple}.exe`);
copyFileSync(process.execPath, outExe);
const sentinel = readFileSync(outExe)
  .toString("latin1")
  .match(/NODE_SEA_FUSE_[0-9a-f]{32}/)?.[0];
if (!sentinel) throw new Error("Could not find the Node SEA sentinel in node.exe");
await inject(outExe, "NODE_SEA_BLOB", readFileSync(join(buildDir, "sea-prep.blob")), {
  sentinelFuse: sentinel,
});

// 4. Ship the native add-on beside the app resources.
const addon = join(
  root,
  "node_modules",
  "better-sqlite3-multiple-ciphers",
  "prebuilds",
  "win32-x64.node",
);
if (!existsSync(addon))
  throw new Error(`Missing better-sqlite3-multiple-ciphers prebuild: ${addon}`);
copyFileSync(addon, join(nativeDir, "better_sqlite3.node"));

console.log(`built ${outExe}`);
