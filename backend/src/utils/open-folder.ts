import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Folders opened so far (for tests, which never open a real window). */
export const openedFolders: string[] = [];

/**
 * Opens a folder in the system's file manager (File Explorer on Windows). Only ever called with
 * the app's own folders, never with a path that came from a request. It is created first if it
 * does not exist yet (the backups folder before the first backup, say).
 */
export function openFolder(folder: string): void {
  // File Explorer opens Documents instead when given a relative path (the data folder can be set
  // as one, such as ../data) or one written with forward slashes: always pass the full path.
  const dir = path.resolve(folder);
  fs.mkdirSync(dir, { recursive: true });
  openedFolders.push(dir);
  if (process.env["VITEST"]) return;
  const command =
    process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined); // no file manager: nothing to do
  child.unref();
}
