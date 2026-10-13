#!/usr/bin/env node
// Copies the overlay art (mist.mp4, dust.mp4, paper.webp) from art/source/overlays/ to public/overlays/,
// where the site fetches it. A missing file is fine: the site skips an overlay it cannot load.
// Files in public/overlays/ that are no longer in the source folder are removed (it is generated).
//
//   npm run overlays        runs before npm run dev and npm run build
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./lib/load-ts.mjs";

const SOURCE = path.join(repoRoot, "art", "source", "overlays");
const TARGET = path.join(repoRoot, "public", "overlays");
const KINDS = new Set([".mp4", ".webm", ".webp"]);

const list = (dir) => readdir(dir).catch(() => []);

const wanted = (await list(SOURCE)).filter((name) => KINDS.has(path.extname(name).toLowerCase()));
await mkdir(TARGET, { recursive: true });

let copied = 0;
for (const name of wanted) {
  const from = path.join(SOURCE, name);
  const to = path.join(TARGET, name);
  const [a, b] = await Promise.all([stat(from), stat(to).catch(() => null)]);
  if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
  await copyFile(from, to);
  copied++;
}
let removed = 0;
for (const name of await list(TARGET)) {
  if (wanted.includes(name)) continue;
  await rm(path.join(TARGET, name), { force: true, recursive: true });
  removed++;
}
console.log(`overlays: ${wanted.length ? wanted.join(", ") : "none in art/source/overlays"}${copied ? ` (${copied} copied)` : ""}${removed ? ` (${removed} removed)` : ""}`);
