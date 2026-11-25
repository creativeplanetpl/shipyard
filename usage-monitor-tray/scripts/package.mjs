// Builds release/AI Monitor-win32-x64 from dist/ and dist-electron/ (both already bundled, so no node_modules ship).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packager = require("@electron/packager");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = (file) => file === "" || file === "/package.json" || file === "/dist" || file.startsWith("/dist/") || file === "/dist-electron" || file.startsWith("/dist-electron/");

const [out] = await (packager.packager || packager)({
  dir: root,
  out: path.join(root, "release"),
  name: "AI Monitor",
  platform: "win32",
  arch: "x64",
  electronVersion: require("electron/package.json").version,
  overwrite: true,
  asar: true,
  prune: false,
  ignore: (file) => !keep(file.replaceAll("\\", "/")),
});
console.log(`Packaged: ${out}`);
