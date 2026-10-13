#!/usr/bin/env node
// Placeholder frames, so the site runs end to end before any real art exists.
//
// For every clip in src/content/story.ts this writes the chapter's frame count of painterly
// gradient frames in the style-bible palette, with the chapter number and title set large, as
// WebP in every tier (public/frames/<clip>/<tier>/f_###.webp), plus poster.webp and
// manifest.json. Each frame drifts a little further than the last, so scrubbing is visible, and
// carries the anchors the joins use: a dark pupil at c02's pupil anchor and a paper border
// around c08's photoRect.
//
// Folders holding real frames (a manifest without "placeholder": true, written by
// npm run art:import) are never touched. Unchanged placeholders are skipped by fingerprint.
// Optional clips (c03-portal) get a placeholder only while no clip has real frames: once real art
// is in, an optional clip without real frames is left out (its placeholder removed), so the story
// skips it and joins past it with optional.joinWhenSkipped, as the finished film will.
//
//   npm run placeholders                      write what is missing or stale
//   npm run placeholders -- --force           rewrite every placeholder clip
//   npm run placeholders -- --only c02-eye    one clip
//   npm run placeholders -- --without c03-portal
//                                             skip a clip and remove its placeholder frames
//                                             (to preview the story without the optional c03)
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadStory, repoRoot } from "./lib/load-ts.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const FRAMES_DIR = path.join(repoRoot, "public", "frames");

/** Look of each placeholder: three palette colours (ground, light, accent). */
const LOOKS = {
  "c01-follow": ["moss", "brass", "terracotta"],
  "c02-eye": ["teak", "brass", "ink"],
  "c03-portal": ["valley", "sky", "moss"],
  "c04-descent": ["valley", "moss", "terracotta"],
  "c05-enter": ["teak", "brass", "paper"],
  "c06-book": ["valley", "teak", "brass"],
  "c07-pages": ["paper", "brass", "teak"],
  "c08-sea-alive": ["sky", "valley", "paper"],
  "c09-shore": ["sky", "moss", "paper"],
  "c10-sky": ["sky", "paper", "brass"],
};
const FALLBACK_LOOK = ["valley", "moss", "brass"];

const QUALITY = { 1440: 78, 768: 72 };
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Helvetica, Arial, sans-serif";

function parseArgs(argv) {
  const args = { force: false, only: null, without: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--without") args.without.add(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/placeholders.mjs [--force] [--only <clip>] [--without <clip>]");
      process.exit(0);
    } else {
      console.error(`placeholders: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const exists = (p) => access(p).then(() => true, () => false);

async function readManifest(clip) {
  try {
    return JSON.parse(await readFile(path.join(FRAMES_DIR, clip, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]);
}

/** Small deterministic random generator, so placeholders are identical on every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A canvas-texture layer for one tier: soft blotches plus fine grain around mid grey, composited
 * with soft-light so it reads as paint without shifting the palette.
 */
async function paperTexture(width, height, seed) {
  const rand = rng(seed);
  const cw = Math.max(8, Math.round(width / 48));
  const ch = Math.max(5, Math.round(height / 48));
  const coarse = Buffer.alloc(cw * ch);
  for (let i = 0; i < coarse.length; i++) coarse[i] = 128 + Math.round((rand() - 0.5) * 70);
  const soft = await sharp(coarse, { raw: { width: cw, height: ch, channels: 1 } })
    .resize(width, height, { kernel: "cubic" })
    .blur(Math.max(1, width / 400))
    .extractChannel(0)
    .raw()
    .toBuffer();
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < soft.length; i++, j += 3) {
    const v = Math.max(0, Math.min(255, soft[i] + Math.round((rand() - 0.5) * 22)));
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
  }
  return out;
}

/** The SVG for one frame: gradient ground, drifting paint blobs, anchors and the chapter type. */
function frameSvg({ chapter, palette, width, height, index, count }) {
  const t = count > 1 ? index / (count - 1) : 0;
  const [groundName, lightName, accentName] = LOOKS[chapter.clip] ?? FALLBACK_LOOK;
  const ground = palette[groundName];
  const light = palette[lightName];
  const accent = palette[accentName];
  const ink = palette.ink;
  const paper = palette.paper;
  const rand = rng(chapter.number * 7919);

  // The "camera": a slow push in plus a sideways drift, so every frame differs from the last.
  const zoom = 1 + 0.12 * t;
  const driftX = (t - 0.5) * width * 0.06;
  const angle = -18 + 22 * t;

  const blobs = [];
  for (let b = 0; b < 9; b++) {
    const bx = rand() * width;
    const by = rand() * height;
    const r = (0.18 + rand() * 0.32) * width;
    const sway = Math.sin(t * Math.PI * 2 * (0.3 + rand() * 0.4) + b) * width * 0.02;
    blobs.push(
      `<ellipse cx="${(bx + sway).toFixed(1)}" cy="${(by - sway * 0.5).toFixed(1)}" rx="${r.toFixed(1)}" ry="${(r * (0.45 + rand() * 0.4)).toFixed(1)}" transform="rotate(${(rand() * 60 - 30).toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)})" fill="url(#blob${b % 4})" opacity="${(0.35 + rand() * 0.35).toFixed(2)}"/>`,
    );
  }

  const stops = (c) => `<stop offset="0" stop-color="${c}" stop-opacity="1"/><stop offset="1" stop-color="${c}" stop-opacity="0"/>`;
  const blobColours = [light, accent, mix(ground, light, 0.5), mix(accent, paper, 0.3)];
  const defs = blobColours
    .map((c, i) => `<radialGradient id="blob${i}" cx="0.5" cy="0.5" r="0.5">${stops(c)}</radialGradient>`)
    .join("");

  // Anchors: c02 ends on a dark pupil, c08 keeps its photograph inside a lighter paper border.
  let anchor = "";
  if (chapter.anchors?.pupil) {
    const { x, y } = chapter.anchors.pupil;
    const r = height * (0.05 + 0.13 * t);
    anchor =
      `<circle cx="${x * width}" cy="${y * height}" r="${(r * 2.4).toFixed(1)}" fill="${mix(accent, light, 0.35)}" opacity="0.75"/>` +
      `<circle cx="${x * width}" cy="${y * height}" r="${r.toFixed(1)}" fill="${ink}"/>`;
  }
  if (chapter.anchors?.photoRect) {
    const { x, y, w, h } = chapter.anchors.photoRect;
    const m = 0.04;
    anchor =
      `<rect x="${(x - m) * width}" y="${(y - m * 1.6) * height}" width="${(w + 2 * m) * width}" height="${(h + 2 * m * 1.6) * height}" fill="${paper}" opacity="0.92"/>` +
      `<rect x="${x * width}" y="${y * height}" width="${w * width}" height="${h * height}" fill="url(#sea)"/>`;
  }
  const seaDefs = `<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.sky}"/><stop offset="0.55" stop-color="${mix(palette.sky, palette.valley, 0.5)}"/><stop offset="1" stop-color="${palette.valley}"/></linearGradient>`;

  const num = String(chapter.number).padStart(2, "0");
  const big = height * 0.42;
  const titleSize = height * 0.085;
  const small = Math.max(11, height * 0.022);
  const textColour = groundName === "paper" || groundName === "sky" ? ink : paper;
  const shadow = textColour === ink ? paper : ink;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="ground" gradientTransform="rotate(${angle.toFixed(2)} 0.5 0.5)">
      <stop offset="0" stop-color="${mix(ground, ink, 0.25)}"/>
      <stop offset="0.55" stop-color="${ground}"/>
      <stop offset="1" stop-color="${mix(ground, light, 0.55)}"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.55" stop-color="${ink}" stop-opacity="0"/>
      <stop offset="1" stop-color="${ink}" stop-opacity="0.45"/>
    </radialGradient>
    ${defs}
    ${seaDefs}
  </defs>
  <rect width="100%" height="100%" fill="url(#ground)"/>
  <g transform="translate(${(width / 2 + driftX).toFixed(1)} ${(height / 2).toFixed(1)}) scale(${zoom.toFixed(4)}) translate(${-width / 2} ${-height / 2})">
    ${blobs.join("\n    ")}
  </g>
  ${anchor}
  <rect width="100%" height="100%" fill="url(#vignette)"/>
  <g font-family="${SERIF}" text-anchor="middle">
    <text x="${width / 2 + 3}" y="${height * 0.53 + 3}" font-size="${big.toFixed(1)}" fill="${shadow}" opacity="0.25">${num}</text>
    <text x="${width / 2}" y="${height * 0.53}" font-size="${big.toFixed(1)}" fill="${textColour}" opacity="0.88">${num}</text>
    <text x="${width / 2}" y="${height * 0.72}" font-size="${titleSize.toFixed(1)}" font-style="italic" fill="${textColour}">${escapeXml(chapter.title)}</text>
  </g>
  <g font-family="${SANS}" font-size="${small.toFixed(1)}" fill="${textColour}" opacity="0.75">
    <text x="${small * 1.5}" y="${height - small * 1.5}">${escapeXml(chapter.clip)} · placeholder</text>
    <text x="${width - small * 1.5}" y="${height - small * 1.5}" text-anchor="end">frame ${index + 1} / ${count}</text>
  </g>
  <rect x="0" y="${height - small * 0.45}" width="${(width * t).toFixed(1)}" height="${(small * 0.45).toFixed(1)}" fill="${textColour}" opacity="0.6"/>
</svg>`;
}

async function runPool(tasks, size) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chapters, palette, tune } = await loadStory();
  const scriptHash = createHash("sha1").update(await readFile(SCRIPT)).digest("hex");
  const tiers = [...tune.tiers];
  const textures = new Map();
  sharp.concurrency(0);
  const pool = Math.max(2, Math.min(8, os.cpus().length));

  let wrote = 0;
  let kept = 0;
  const started = Date.now();

  const manifests = new Map();
  for (const chapter of chapters) manifests.set(chapter.clip, await readManifest(chapter.clip));
  const realArt = [...manifests.values()].some((m) => m && m.placeholder !== true);

  for (const chapter of chapters) {
    const clip = chapter.clip;
    if (args.only && clip !== args.only && chapter.id !== args.only) continue;
    const dir = path.join(FRAMES_DIR, clip);
    const manifest = manifests.get(clip);
    const isReal = manifest && manifest.placeholder !== true;

    if (chapter.optional && realArt && !isReal) {
      if (manifest) {
        await rm(dir, { recursive: true, force: true });
        console.log(
          `  ${clip}: optional placeholder removed (real art is in and this clip has none, so the story joins past it with '${chapter.optional.joinWhenSkipped}')`,
        );
      }
      continue;
    }

    if (args.without.has(clip) || args.without.has(chapter.id)) {
      if (manifest && !isReal) {
        await rm(dir, { recursive: true, force: true });
        console.log(`  ${clip}: placeholder removed (--without)`);
      } else {
        console.log(`  ${clip}: skipped (--without)`);
      }
      continue;
    }
    if (isReal) {
      console.log(`  ${clip}: real frames present, left alone`);
      kept++;
      continue;
    }

    const fingerprint = createHash("sha1")
      .update(JSON.stringify({ scriptHash, chapter, palette, tiers, look: LOOKS[clip] ?? FALLBACK_LOOK, QUALITY }))
      .digest("hex");
    const last = `f_${String(chapter.frames).padStart(3, "0")}.webp`;
    const complete =
      manifest?.fingerprint === fingerprint &&
      (await Promise.all(tiers.map((tier) => exists(path.join(dir, String(tier), last))))).every(Boolean);
    if (complete && !args.force) {
      kept++;
      continue;
    }

    await rm(dir, { recursive: true, force: true });
    const tierInfo = {};
    for (const tier of tiers) {
      const width = tier;
      const height = Math.round(tier / tune.frameAspect);
      tierInfo[tier] = { count: chapter.frames, width, height };
      await mkdir(path.join(dir, String(tier)), { recursive: true });
      if (!textures.has(tier)) textures.set(tier, await paperTexture(width, height, 1234 + tier));
      const texture = textures.get(tier);
      const tasks = Array.from({ length: chapter.frames }, (_, index) => async () => {
        const svg = frameSvg({ chapter, palette, width, height, index, count: chapter.frames });
        const file = path.join(dir, String(tier), `f_${String(index + 1).padStart(3, "0")}.webp`);
        await sharp(Buffer.from(svg))
          .resize(width, height)
          .composite([{ input: texture, raw: { width, height, channels: 3 }, blend: "soft-light" }])
          .webp({ quality: QUALITY[tier] ?? 75 })
          .toFile(file);
      });
      await runPool(tasks, pool);
    }

    const firstFrame = path.join(dir, String(tiers[0]), "f_001.webp");
    await writeFile(path.join(dir, "poster.webp"), await readFile(firstFrame));
    await writeFile(
      path.join(dir, "manifest.json"),
      `${JSON.stringify({ clip, placeholder: true, fingerprint, frames: chapter.frames, tiers: tierInfo }, null, 2)}\n`,
    );
    wrote++;
    console.log(`  ${clip}: ${chapter.frames} frames x ${tiers.length} tiers`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`placeholders: ${wrote} clip(s) written, ${kept} up to date or real, in ${secs}s -> public/frames/`);
}

main().catch((err) => {
  console.error(`placeholders: ${err?.stack ?? err}`);
  process.exit(1);
});
