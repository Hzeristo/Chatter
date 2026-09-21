import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const source = path.join(root, "public");
const target = path.join(root, "dist", "public");
const katexSource = path.join(root, "node_modules", "katex", "dist");
const katexTarget = path.join(target, "vendor", "katex");

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
await mkdir(katexTarget, { recursive: true });
await cp(path.join(katexSource, "katex.min.css"), path.join(katexTarget, "katex.min.css"));
await cp(path.join(katexSource, "fonts"), path.join(katexTarget, "fonts"), {
  recursive: true,
});
