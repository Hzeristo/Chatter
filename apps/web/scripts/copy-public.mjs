import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const source = path.join(root, "public");
const target = path.join(root, "dist", "public");

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
