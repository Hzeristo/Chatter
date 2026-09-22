import { mkdir } from "node:fs/promises";
import path from "node:path";

import { lock } from "proper-lockfile";

const STALE_AFTER_MS = 15_000;
const UPDATE_EVERY_MS = 5_000;

export async function acquireDataDirectoryLease(
  dataDirectory: string,
): Promise<() => Promise<void>> {
  await mkdir(dataDirectory, { recursive: true });
  return lock(dataDirectory, {
    lockfilePath: path.join(dataDirectory, ".owner.lock"),
    stale: STALE_AFTER_MS,
    update: UPDATE_EVERY_MS,
    retries: 0,
    realpath: true,
  });
}
