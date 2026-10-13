#!/usr/bin/env node
// art:import: turns the finished clips in art/source/clips into the frame sequences the site plays.
//
// For every chapter in src/content/story.ts whose art/source/clips/<clip>.mp4 exists:
//   1. normalise it to 24 fps, 1920x1080 (cover crop), near-lossless H.264 without audio: art/work/<clip>.mp4
//   2. pick the chapter's frame count by frame index, evenly spaced, first and last frame included
//   3. write them as WebP: public/frames/<clip>/1440/f_###.webp (quality 78) and /768/ (quality 72)
//   4. write manifest.json ({clip, tiers: {1440: {count}, 768: {count}}, ...}), poster.webp (the first
//      1440 frame) and art/work/<clip>.first.png and .last.png (full size, for npm run art:check)
//   5. keep each tier inside its share of the size budget: first by lowering the quality, then by
//      dropping every n-th frame (never the first or the last); the manifest records the count kept
//
// Only <clip>.mp4 is an input. The *.take<N>.mp4, *.take<N>.json, *.last.png, *.sheet.png and *.json
// files that tools/art-video.mjs writes next to it are ignored.
// A chapter with no clip keeps (or gets) its placeholder frames from scripts/placeholders.mjs, which
// runs at the end; that is never an error. Real frames whose clip has gone are left alone: delete
// public/frames/<clip>/ to go back to the placeholder.
//
// The clip, the chapter's frame count, the budget and this script (with scripts/lib/art-files.mjs) are
// fingerprinted into manifest.json, so unchanged clips are skipped; the normalised clip in art/work is
// reused while its source is unchanged.
//
//   npm run art:import                      import what is new or changed
//   npm run art:import -- --force           import every clip again
//   npm run art:import -- --only c02-eye    one clip (an id, or a unique prefix such as c02)
//
// Budget, per tier across the whole film (MB = 1,000,000 bytes, as in docs/EXPORT.md):
//   ART_BUDGET_MB       1440 tier, default 60
//   ART_BUDGET_768_MB   768 tier, default 22
// Each clip gets the share of its frames (its frames / all frames in story.ts), so clips can be imported
// one at a time and the film still fits when they are all in.
//
// Needs ffmpeg and ffprobe on PATH (or the env vars FFMPEG and FFPROBE set to their paths), and sharp.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadStory, repoRoot } from "./lib/load-ts.mjs";
import {
  CLIPS_DIR,
  FRAMES_DIR,
  MB,
  SPEC_CLIP_IDS,
  WORK_DIR,
  exists,
  frameFile,
  frameName,
  isReal,
  matchChapter,
  mb,
  readManifest,
  rel,
  runPool,
  sourceClip,
  table,
  workFile,
} from "./lib/art-files.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const LIB = path.join(repoRoot, "scripts", "lib", "art-files.mjs");
const PLACEHOLDERS = path.join(repoRoot, "scripts", "placeholders.mjs");

/** Normalised clip: frame rate, width (height follows tune.frameAspect), x264 quality. */
const NORMALISE = { fps: 24, width: 1920, crf: 12, preset: "slow" };
/** WebP quality per tier, the lowest quality the budget may push it to, and the step down. */
const QUALITY = { 1440: 78, 768: 72 };
const QUALITY_FLOOR = { 1440: 60, 768: 54 };
const QUALITY_STEP = 6;
const WEBP_EFFORT = 4;
/** Budget per tier for the whole film, in MB, and the env var that overrides it. */
const BUDGET = {
  1440: { env: "ART_BUDGET_MB", mb: 60 },
  768: { env: "ART_BUDGET_768_MB", mb: 22 },
};

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const POOL = Math.max(2, Math.min(8, os.cpus().length));

function usage(code) {
  console.log("usage: node scripts/art-import.mjs [--force] [--only <clip>]");
  process.exit(code);
}

function parseArgs(argv) {
  const args = { force: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--only") {
      args.only = argv[++i];
      if (!args.only) usage(2);
    } else if (a === "-h" || a === "--help") usage(0);
    else {
      console.error(`art:import: unknown argument ${a}`);
      usage(2);
    }
  }
  return args;
}

function readBudgets(tiers) {
  const budgets = {};
  for (const tier of tiers) {
    const spec = BUDGET[tier];
    if (!spec || !(tier in QUALITY)) {
      console.error(`art:import: story.ts lists tier ${tier}, but this script has no quality or budget for it`);
      process.exit(2);
    }
    const raw = process.env[spec.env];
    const value = raw === undefined || raw === "" ? spec.mb : Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`art:import: ${spec.env} must be a positive number of MB (got "${raw}")`);
      process.exit(2);
    }
    budgets[tier] = { env: spec.env, mb: value, bytes: value * MB };
  }
  return budgets;
}

// ---------- ffmpeg ----------

let ff = null;

/** ffmpeg and ffprobe, checked once, the first time a clip needs them. Stops with install help if missing. */
function requireFfmpeg() {
  if (ff) return ff;
  const version = (bin) => {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
    return r.error || r.status !== 0 ? null : r.stdout.split("\n")[0];
  };
  const ffmpegVersion = version(FFMPEG);
  const ffprobeVersion = version(FFPROBE);
  const missing = [!ffmpegVersion && "ffmpeg", !ffprobeVersion && "ffprobe"].filter(Boolean);
  if (missing.length) {
    console.error(
      [
        "",
        `art:import needs ${missing.join(" and ")}, which ${missing.length > 1 ? "were" : "was"} not found.`,
        "Install ffmpeg (it brings ffprobe), then run npm run art:import again:",
        "  macOS          brew install ffmpeg",
        "  Debian/Ubuntu  sudo apt install ffmpeg",
        "  Windows        winget install Gyan.FFmpeg",
        "Or set FFMPEG and FFPROBE to the full paths of the binaries.",
        "Nothing was changed; the site keeps playing its current frames.",
      ].join("\n"),
    );
    process.exit(1);
  }
  const encoders = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
  if (!/\blibx264\b/.test(encoders)) {
    console.error(`art:import: this ffmpeg (${ffmpegVersion}) has no libx264 encoder. Install a full build (brew install ffmpeg).`);
    process.exit(1);
  }
  // -fps_mode replaced -vsync in ffmpeg 5.1; selected frames must pass through without being duplicated.
  const m = ffmpegVersion.match(/version n?(\d+)\.(\d+)/);
  const modern = !m || Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2]) >= 1);
  ff = { version: ffmpegVersion, passthrough: modern ? ["-fps_mode", "passthrough"] : ["-vsync", "passthrough"] };
  return ff;
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`${path.basename(bin)}: ${r.error.message}`);
  if (r.status !== 0) {
    const tail = (r.stderr || "").trim().split("\n").slice(-4).join(" | ");
    throw new Error(`${path.basename(bin)} failed: ${tail || `exit ${r.status}`}`);
  }
  return r.stdout.trim();
}

const ffmpeg = (args) => run(FFMPEG, ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", ...args]);

function countFrames(file) {
  const out = run(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file,
  ]);
  const n = parseInt(out, 10);
  if (!Number.isFinite(n) || n < 1) throw new Error(`no video frames in ${rel(file)}`);
  return n;
}

function duration(file) {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = parseFloat(out);
  return Number.isFinite(d) ? d : null;
}

// ---------- helpers ----------

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

const sha1 = (value) => createHash("sha1").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const sum = (buffers) => buffers.reduce((n, b) => n + b.length, 0);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isFile()) total += (await stat(path.join(dir, e.name))).size;
  }
  return total;
}

/** `wanted` source frame indices, evenly spaced over `total` frames, first and last included. */
function evenly(total, wanted) {
  if (wanted <= 1 || total <= 1) return Array.from({ length: Math.max(1, wanted) }, () => 0);
  return Array.from({ length: wanted }, (_, i) => Math.round((i * (total - 1)) / (wanted - 1)));
}

/** Indices kept when every n-th frame (1-based) is dropped; the first and last frame always stay. */
function keepEvery(count, n) {
  const keep = [];
  for (let i = 0; i < count; i++) {
    if ((i + 1) % n === 0 && i !== 0 && i !== count - 1) continue;
    keep.push(i);
  }
  return keep;
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th")}`;

// ---------- one clip ----------

async function isComplete(clip, manifest, tiers) {
  for (const tier of tiers) {
    const count = manifest?.tiers?.[tier]?.count;
    if (!count) return false;
    if (!(await exists(frameFile(clip, tier, 0))) || !(await exists(frameFile(clip, tier, count - 1)))) return false;
  }
  return (
    (await exists(path.join(FRAMES_DIR, clip, "poster.webp"))) &&
    (await exists(workFile(clip, ".first.png"))) &&
    (await exists(workFile(clip, ".last.png")))
  );
}

/** Normalise the source into art/work/<clip>.mp4, unless the one there was made from the same source. */
async function normalise(clip, src, sourceHash, height, force) {
  const out = workFile(clip, ".mp4");
  const info = workFile(clip, ".norm.json");
  const key = sha1({ sourceHash, ...NORMALISE, height });
  const previous = await readJson(info);
  if (!force && previous?.key === key && (await exists(out))) return { file: out, reused: true };

  const { fps, width, crf, preset } = NORMALISE;
  const part = workFile(clip, ".part.mp4");
  ffmpeg([
    "-i", src,
    "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`,
    "-c:v", "libx264", "-crf", String(crf), "-preset", preset, "-pix_fmt", "yuv420p",
    "-an", "-movflags", "+faststart", part,
  ]);
  await rename(part, out);
  await writeFile(info, `${JSON.stringify({ clip, key, source: rel(src), sourceSha1: sourceHash, ...NORMALISE, height }, null, 2)}\n`);
  return { file: out, reused: false };
}

/** Encode the picked frames of one tier at a quality: one buffer per pick (repeated picks share one encode). */
async function encodeAt(uniquePngs, pickSlots, quality) {
  const encoded = new Array(uniquePngs.length);
  await runPool(
    uniquePngs.map((file, k) => async () => {
      encoded[k] = await sharp(file).webp({ quality, effort: WEBP_EFFORT }).toBuffer();
    }),
    POOL,
  );
  return pickSlots.map((k) => encoded[k]);
}

/** Encode one tier inside its byte share: lower the quality first, then drop every n-th frame. */
async function fitTier(tier, uniquePngs, pickSlots, share) {
  const base = QUALITY[tier];
  const floor = QUALITY_FLOOR[tier];
  let quality = base;
  let frames = await encodeAt(uniquePngs, pickSlots, quality);
  let bytes = sum(frames);
  const firstBytes = bytes;
  while (bytes > share && quality > floor) {
    quality = Math.max(floor, quality - QUALITY_STEP);
    frames = await encodeAt(uniquePngs, pickSlots, quality);
    bytes = sum(frames);
  }

  let dropEvery = null;
  const picked = frames.length;
  if (bytes > share && frames.length > 2) {
    dropEvery = 2;
    for (let n = frames.length; n >= 2; n--) {
      if (sum(keepEvery(frames.length, n).map((i) => frames[i])) <= share) {
        dropEvery = n;
        break;
      }
    }
    frames = keepEvery(frames.length, dropEvery).map((i) => frames[i]);
    bytes = sum(frames);
  }

  let note = `${frames.length} frames, ${mb(bytes)} MB at q${quality} (share ${mb(share)} MB)`;
  if (quality !== base || dropEvery) {
    const steps = [`${mb(firstBytes)} MB at q${base} is over the ${mb(share)} MB share`];
    if (quality !== base) steps.push(`quality ${base} -> ${quality}`);
    if (dropEvery) steps.push(`every ${ordinal(dropEvery)} frame dropped (${picked} -> ${frames.length} frames)`);
    steps.push(`${mb(bytes)} MB`);
    note = steps.join(", ");
  }
  const over = bytes > share;
  if (over) note += `; STILL OVER: raise ${BUDGET[tier].env} or lower the frame count in story.ts`;
  return { frames, quality, dropEvery, bytes, note, over };
}

async function importClip(chapter, ctx) {
  const { clip, frames: wanted } = chapter;
  const { tiers, tune, budgets, totalFrames, scriptHash, force } = ctx;
  const src = sourceClip(clip);
  const height = Math.round(NORMALISE.width / tune.frameAspect);
  const tierHeight = (tier) => Math.round(tier / tune.frameAspect);
  const shares = Object.fromEntries(tiers.map((t) => [t, Math.floor((budgets[t].bytes * wanted) / totalFrames)]));

  const sourceHash = await hashFile(src);
  const fingerprint = sha1({ scriptHash, sourceHash, wanted, tiers, shares, frameAspect: tune.frameAspect });
  const manifest = await readManifest(clip);
  if (!force && isReal(manifest) && manifest.fingerprint === fingerprint && (await isComplete(clip, manifest, tiers))) {
    return { state: "unchanged, skipped" };
  }

  const tools = requireFfmpeg();
  const started = Date.now();
  const seconds = duration(src);
  console.log(`  ${clip}: ${rel(src)}${seconds ? ` (${seconds.toFixed(2)} s)` : ""}`);

  // 1. Normalise.
  const norm = await normalise(clip, src, sourceHash, height, force);
  console.log(`    normalised: ${rel(norm.file)}${norm.reused ? " (unchanged, reused)" : ""}`);

  // 2. Pick the frames.
  const total = countFrames(norm.file);
  const picks = evenly(total, wanted);
  const unique = [...new Set(picks)].sort((a, b) => a - b);
  const slotOf = new Map(unique.map((n, k) => [n, k]));
  const pickSlots = picks.map((n) => slotOf.get(n));
  if (total < wanted) {
    console.log(`    note: the clip has ${total} frames at ${NORMALISE.fps} fps but story.ts wants ${wanted}, so some frames repeat`);
  }

  // 3. Extract them once, at every tier size, plus the full-size first and last frame.
  const stage = path.join(WORK_DIR, `import-${clip}`);
  await rm(stage, { recursive: true, force: true });
  for (const tier of tiers) await mkdir(path.join(stage, "png", String(tier)), { recursive: true });
  await mkdir(path.join(stage, "ends"), { recursive: true });
  const ends = total > 1 ? [0, total - 1] : [0];
  const select = (indices) => `select='${indices.map((n) => `eq(n,${n})`).join("+")}'`;
  const graph = [
    "[0:v]split=2[pick][ends]",
    `[pick]${select(unique)},split=${tiers.length}${tiers.map((_, i) => `[p${i}]`).join("")}`,
    ...tiers.map((tier, i) => `[p${i}]scale=${tier}:${tierHeight(tier)}:flags=lanczos[t${i}]`),
    `[ends]${select(ends)}[e]`,
  ].join(";");
  const png = ["-c:v", "png", "-compression_level", "1"];
  ffmpeg([
    "-i", norm.file,
    "-filter_complex", graph,
    ...tiers.flatMap((tier, i) => ["-map", `[t${i}]`, ...tools.passthrough, ...png, path.join(stage, "png", String(tier), "s_%04d.png")]),
    "-map", "[e]", ...tools.passthrough, ...png, path.join(stage, "ends", "e_%d.png"),
  ]);
  for (const tier of tiers) {
    const n = (await readdir(path.join(stage, "png", String(tier)))).length;
    if (n !== unique.length) throw new Error(`ffmpeg wrote ${n} frames for the ${tier} tier, expected ${unique.length}`);
  }
  const endFiles = (await readdir(path.join(stage, "ends"))).sort();
  if (endFiles.length !== ends.length) throw new Error(`ffmpeg wrote ${endFiles.length} end frames, expected ${ends.length}`);
  await copyFile(path.join(stage, "ends", endFiles[0]), workFile(clip, ".first.png"));
  await copyFile(path.join(stage, "ends", endFiles[endFiles.length - 1]), workFile(clip, ".last.png"));

  // 4. Encode each tier inside its share of the budget.
  const out = path.join(stage, "out");
  const tierInfo = {};
  const notes = [];
  let over = false;
  for (const tier of tiers) {
    const pngs = unique.map((_, k) => path.join(stage, "png", String(tier), `s_${String(k + 1).padStart(4, "0")}.png`));
    const fit = await fitTier(tier, pngs, pickSlots, shares[tier]);
    const dir = path.join(out, String(tier));
    await mkdir(dir, { recursive: true });
    await Promise.all(fit.frames.map((buf, i) => writeFile(path.join(dir, frameName(i)), buf)));
    tierInfo[tier] = {
      count: fit.frames.length,
      width: tier,
      height: tierHeight(tier),
      quality: fit.quality,
      bytes: fit.bytes,
      dropEvery: fit.dropEvery,
    };
    notes.push(`${tier}: ${fit.note}`);
    over ||= fit.over;
    console.log(`    ${tier}: ${fit.note}`);
  }

  // 5. Poster and manifest, then swap the folder in.
  await copyFile(path.join(out, String(tiers[0]), frameName(0)), path.join(out, "poster.webp"));
  const next = {
    clip,
    placeholder: false,
    fingerprint,
    frames: wanted,
    tiers: tierInfo,
    poster: "poster.webp",
    source: {
      file: rel(src),
      sha1: sourceHash,
      seconds,
      normalisedFrames: total,
      fps: NORMALISE.fps,
    },
  };
  await writeFile(path.join(out, "manifest.json"), `${JSON.stringify(next, null, 2)}\n`);
  const dest = path.join(FRAMES_DIR, clip);
  await mkdir(FRAMES_DIR, { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(out, dest);
  await rm(stage, { recursive: true, force: true });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`    -> ${rel(dest)}/ and ${rel(workFile(clip, ".first.png"))}, .last.png in ${secs}s`);
  const state = manifest && !isReal(manifest) ? "imported (placeholder replaced)" : force && manifest ? "imported again (--force)" : "imported";
  return { state: over ? `${state}, OVER BUDGET` : state, notes };
}

// ---------- main ----------

async function listSourceFolder(chapters) {
  let names = [];
  try {
    names = (await readdir(CLIPS_DIR, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return { stray: [], takes: new Set() };
  }
  const clips = new Set(chapters.map((c) => c.clip));
  const stray = [];
  const takes = new Set();
  for (const name of names) {
    const take = name.match(/^(.+)\.take\d+\.mp4$/);
    if (take) {
      takes.add(take[1]);
      continue;
    }
    if (name.toLowerCase().endsWith(".mp4") && !clips.has(name.slice(0, -4))) stray.push(name);
  }
  return { stray, takes };
}

async function tierCell(clip, tier) {
  const manifest = await readManifest(clip);
  if (!manifest) return { text: "-", bytes: 0, real: false };
  const info = manifest.tiers?.[tier];
  const bytes = await dirBytes(path.join(FRAMES_DIR, clip, String(tier)));
  const real = isReal(manifest);
  const count = info?.count ?? manifest.frames ?? "?";
  const kind = real ? `q${info?.quality ?? "?"}` : "placeholder";
  return { text: `${count} fr ${kind} ${mb(bytes)} MB`, bytes, real };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chapters, tune } = await loadStory();
  const tiers = [...tune.tiers];
  const budgets = readBudgets(tiers);
  const totalFrames = chapters.reduce((n, c) => n + c.frames, 0);
  const scriptHash = sha1((await Promise.all([SCRIPT, LIB].map((f) => readFile(f, "utf8")))).join("\n"));

  let targets = chapters;
  if (args.only) {
    const hit = matchChapter(chapters, args.only);
    if (!hit) {
      console.error(`art:import: --only ${args.only} matches no single clip. Clips: ${chapters.map((c) => c.clip).join(" ")}`);
      process.exit(2);
    }
    targets = [hit];
  }

  const storyIds = chapters.map((c) => c.clip);
  const notInSpec = storyIds.filter((id) => SPEC_CLIP_IDS.length && !SPEC_CLIP_IDS.includes(id));
  const notInStory = SPEC_CLIP_IDS.filter((id) => !storyIds.includes(id));
  if (notInSpec.length || notInStory.length) {
    console.log(`warning: story.ts and art/prompts.json list different clips (${[...notInSpec, ...notInStory].join(", ")})`);
  }

  const { stray, takes } = await listSourceFolder(chapters);
  const budgetText = tiers.map((t) => `${t}: ${budgets[t].mb} MB`).join(", ");
  console.log(`art:import: clips from ${rel(CLIPS_DIR)}/, budget ${budgetText} (each clip gets its share by frame count)`);
  for (const name of stray) console.log(`  ignored ${rel(path.join(CLIPS_DIR, name))}: not a clip id in story.ts`);

  await mkdir(WORK_DIR, { recursive: true });
  const ctx = { tiers, tune, budgets, totalFrames, scriptHash, force: args.force };
  const states = new Map();
  let failures = 0;

  for (const chapter of targets) {
    const { clip } = chapter;
    if (!(await exists(sourceClip(clip)))) {
      const manifest = await readManifest(clip);
      let state = isReal(manifest) ? "real frames kept (its clip is gone)" : "no clip: placeholder";
      if (takes.has(clip)) state += `; takes waiting: node tools/art-video.mjs --pick ${clip} <n>`;
      states.set(clip, state);
      continue;
    }
    try {
      const result = await importClip(chapter, ctx);
      states.set(clip, result.state);
    } catch (err) {
      failures++;
      states.set(clip, `FAILED: ${err.message}`);
      console.error(`  ${clip}: FAILED: ${err.message}`);
      await rm(path.join(WORK_DIR, `import-${clip}`), { recursive: true, force: true });
    }
  }

  // Every chapter without real frames falls back to its placeholder (optional ones are left out once real art is in).
  console.log("placeholders for the clips that have no real frames:");
  const fallback = spawnSync(process.execPath, [PLACEHOLDERS, ...(args.only ? ["--only", targets[0].clip] : [])], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (fallback.status !== 0) {
    failures++;
    console.error("art:import: scripts/placeholders.mjs failed");
  }

  // Summary, read back from disk.
  const rows = [["clip", "source", ...tiers.map(String), "state"]];
  const totals = Object.fromEntries(tiers.map((t) => [t, { all: 0, real: 0 }]));
  for (const chapter of chapters) {
    const { clip } = chapter;
    const cells = [];
    for (const tier of tiers) {
      const cell = await tierCell(clip, tier);
      totals[tier].all += cell.bytes;
      if (cell.real) totals[tier].real += cell.bytes;
      cells.push(cell.text);
    }
    if (!targets.includes(chapter)) continue;
    let state = states.get(clip) ?? "";
    if (!(await readManifest(clip)) && chapter.optional) {
      state = `left out (optional, no clip): the story joins past it with '${chapter.optional.joinWhenSkipped}'`;
    }
    const source = (await exists(sourceClip(clip))) ? `${clip}.mp4` : "-";
    rows.push([clip, source, ...cells, state]);
  }
  console.log(`\n${table(rows)}\n`);
  for (const tier of tiers) {
    const { all, real } = totals[tier];
    const budget = budgets[tier];
    const flag = real > budget.bytes ? "  OVER BUDGET" : "";
    console.log(
      `${tier} tier: ${mb(all)} MB in public/frames (real frames ${mb(real)} MB) against a budget of ${budget.mb} MB (${budget.env})${flag}`,
    );
  }
  if (failures) {
    console.error(`\nart:import: ${failures} problem(s); the clips that failed keep the frames they had.`);
    process.exit(1);
  }
  console.log("\nNext: npm run art:check");
}

main().catch((err) => {
  console.error(`art:import: ${err?.stack ?? err}`);
  process.exit(1);
});
