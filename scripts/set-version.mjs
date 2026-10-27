// Sets the app's version everywhere it is written, before a release:
//   node scripts/set-version.mjs 0.2.0
// The installer, the updater and the backend all read it from these files.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Give the version as three numbers, such as 0.2.0");
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const file of ["package.json", "backend/package.json", "frontend/package.json"]) {
  const path = join(root, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

const conf = join(root, "src-tauri", "tauri.conf.json");
const tauri = JSON.parse(readFileSync(conf, "utf8"));
tauri.version = version;
writeFileSync(conf, `${JSON.stringify(tauri, null, 2)}\n`);

// Only the [package] version line, not dependency versions.
const cargo = join(root, "src-tauri", "Cargo.toml");
writeFileSync(
  cargo,
  readFileSync(cargo, "utf8").replace(/^version = "[^"]*"/m, `version = "${version}"`),
);

console.log(`Version set to ${version}. Commit, then push the tag v${version} to build a release.`);
