import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");

await build({
  bundle: true,
  entryPoints: [path.join(root, "public", "app.js")],
  format: "esm",
  outfile: path.join(root, "dist", "public", "app.js"),
  platform: "browser",
  sourcemap: true,
  target: ["es2022"],
});
