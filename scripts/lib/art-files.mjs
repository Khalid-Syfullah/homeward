// Where the art pipeline keeps its files, shared by scripts/art-import.mjs and scripts/art-check.mjs.
// The clip folder comes from art/prompts.json (layout.clips), which is read and never written.
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./load-ts.mjs";

function clipsLayout() {
  try {
    const spec = JSON.parse(readFileSync(path.join(repoRoot, "art", "prompts.json"), "utf8"));
    return { dir: spec?.layout?.clips ?? "art/source/clips", ids: (spec?.clips ?? []).map((c) => c.id) };
  } catch {
    return { dir: "art/source/clips", ids: [] };
  }
}

const layout = clipsLayout();

/** art/source/clips: only <clip>.mp4 in here is an input. */
export const CLIPS_DIR = path.join(repoRoot, layout.dir);
/** Clip ids listed in art/prompts.json (empty if it cannot be read). */
export const SPEC_CLIP_IDS = layout.ids;
/** art/work: normalised clips and their first and last frames (generated, git-ignored). */
export const WORK_DIR = path.join(repoRoot, "art", "work");
/** public/frames: the frame sequences the site plays (generated, git-ignored). */
export const FRAMES_DIR = path.join(repoRoot, "public", "frames");

export const exists = (p) => access(p).then(() => true, () => false);

/** Repo-relative path for messages. */
export const rel = (p) => path.relative(repoRoot, p) || ".";

/** Megabytes as docs/EXPORT.md counts them (1 MB = 1,000,000 bytes). */
export const MB = 1e6;
export const mb = (bytes) => (bytes / MB).toFixed(2);

/** f_001.webp for index 0, as framePath() in story.ts names them. */
export const frameName = (index) => `f_${String(index + 1).padStart(3, "0")}.webp`;

export const sourceClip = (clip) => path.join(CLIPS_DIR, `${clip}.mp4`);
export const workFile = (clip, suffix) => path.join(WORK_DIR, `${clip}${suffix}`);
export const frameFile = (clip, tier, index) => path.join(FRAMES_DIR, clip, String(tier), frameName(index));

export async function readManifest(clip) {
  try {
    return JSON.parse(await readFile(path.join(FRAMES_DIR, clip, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Real frames are any manifest not marked as a placeholder (scripts/placeholders.mjs marks its own). */
export const isReal = (manifest) => Boolean(manifest) && manifest.placeholder !== true;

/** A chapter by id or clip, or by a unique prefix such as "c02". Null when nothing or several match. */
export function matchChapter(chapters, query) {
  const q = String(query ?? "").toLowerCase();
  const exact = chapters.filter((c) => c.id.toLowerCase() === q || c.clip.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const prefix = chapters.filter((c) => c.id.toLowerCase().startsWith(q) || c.clip.toLowerCase().startsWith(q));
  return prefix.length === 1 ? prefix[0] : null;
}

/** Run async tasks with at most `size` in flight. */
export async function runPool(tasks, size) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  });
  await Promise.all(workers);
}

/** Left-aligned text table. `rows` are arrays of cells; the first row is the header. */
export function table(rows, gap = 2) {
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, String(cell).length)));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? String(cell) : String(cell).padEnd(widths[i] + gap))).join(""))
    .join("\n");
}
