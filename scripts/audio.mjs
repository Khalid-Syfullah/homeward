#!/usr/bin/env node
// Copies the sound art (c01.m4a to c10.m4a, bed.m4a, and any .ogg fallbacks) from art/source/audio/
// to public/audio/, where the site fetches it. A missing file is fine: the sound engine skips a loop
// it cannot load. Files in public/audio/ that are no longer in the source folder are removed (it is generated).
//
//   npm run audio           runs before npm run dev and npm run build
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./lib/load-ts.mjs";

const SOURCE = path.join(repoRoot, "art", "source", "audio");
const TARGET = path.join(repoRoot, "public", "audio");
const KINDS = new Set([".m4a", ".ogg"]);

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
// The sound engine reads this list, so it never asks for a file that is not there.
await writeFile(path.join(TARGET, "manifest.json"), JSON.stringify({ files: [...wanted].sort() }) + "\n");
let removed = 0;
for (const name of await list(TARGET)) {
  if (wanted.includes(name) || name === "manifest.json") continue;
  await rm(path.join(TARGET, name), { force: true, recursive: true });
  removed++;
}
console.log(`audio: ${wanted.length ? wanted.join(", ") : "none in art/source/audio"}${copied ? ` (${copied} copied)` : ""}${removed ? ` (${removed} removed)` : ""}`);
