#!/usr/bin/env node
// art:check: does every clip end on the frame the next one starts with?
//
// For each join in src/content/story.ts (resolved like the site does: an optional clip without frames is
// skipped and the join past it takes over), this compares the last frame of a clip with the first frame
// of the next, both downscaled to 64x36, and reports the mean absolute difference over the whole frame
// and over the centre third as OK, WARN or FAIL against THRESHOLDS below.
// It also checks the two anchors the joins open from: whether c02's pupil anchor sits on a dark region of
// its last frame (the portal join), and whether c08's last frame has a lighter border around the
// photoRect anchor (the rect join; without one, c08 ends on the full-frame sea and 'push' fits).
//
// What the verdicts mean (docs/CHECKS.md): OK, leave it. WARN, the site's join hides the mismatch (a
// portal or rect join whose anchor holds counts as WARN however different the frames are). FAIL,
// regenerate the later clip from the earlier clip's real last frame, or change the join type.
//
// Frames come from art/work/<clip>.first.png and .last.png (written by npm run art:import), or else from
// the first and last 1440 frame in public/frames/<clip>/. Joins with a placeholder on either side are
// measured but not judged. Exits 1 only when a judged join FAILs.
//
//   npm run art:check
import sharp from "sharp";
import { loadStory } from "./lib/load-ts.mjs";
import { exists, frameFile, isReal, readManifest, rel, table, workFile } from "./lib/art-files.mjs";

/** Mean absolute difference (0..1 over RGB): below warn is OK, below fail is WARN, otherwise FAIL. */
const THRESHOLDS = { warn: 0.04, fail: 0.08 };
/** Size both frames are compared at. */
const GRID = { w: 64, h: 36 };
/** The centre third: the middle third of the width at full height, the part a phone crop keeps (docs/PLAN.md). */
const CENTRE = { x0: 1 / 3, x1: 2 / 3, y0: 0, y1: 1 };
const WHOLE = { x0: 0, x1: 1, y0: 0, y1: 1 };
/** Size the anchor checks run at. */
const ANCHOR_GRID = { w: 128, h: 72 };
/**
 * Pupil: the mean luma (0..1) in a disc of `radius` (share of the frame width) around the anchor must be
 * at most maxLuma and at most maxRatio of the whole frame's mean luma; below `black` it is dark regardless.
 */
const PUPIL = { radius: 0.03, maxLuma: 0.3, maxRatio: 0.6, black: 0.12 };
/**
 * Photograph: a band `band` wide (share of the frame width) just outside photoRect must be at least
 * minDelta lighter than the inside of the rect (inset by `inset` of its size, to skip its edge).
 */
const PHOTO = { band: 0.025, inset: 0.1, minDelta: 0.06 };

const RANK = { OK: 0, WARN: 1, FAIL: 2 };
const grade = (v) => (v < THRESHOLDS.warn ? "OK" : v < THRESHOLDS.fail ? "WARN" : "FAIL");
const worst = (...g) => g.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "OK");
const f2 = (v) => v.toFixed(2);
const f3 = (v) => v.toFixed(3);

// ---------- pixels ----------

async function rgb(file, grid) {
  const { data, info } = await sharp(file)
    .resize(grid.w, grid.h, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

/** Mean absolute difference of two same-size images over a region (0..1 fractions of the frame). */
function mad(a, b, region) {
  const x0 = Math.round(region.x0 * a.w);
  const x1 = Math.round(region.x1 * a.w);
  const y0 = Math.round(region.y0 * a.h);
  const y1 = Math.round(region.y1 * a.h);
  let total = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.w + x) * a.ch;
      const j = (y * b.w + x) * b.ch;
      for (let c = 0; c < 3; c++) total += Math.abs(a.data[i + c] - b.data[j + c]);
      n += 3;
    }
  }
  return n ? total / (n * 255) : 0;
}

/** Rec. 709 luma (0..1) per pixel. */
async function lumaGrid(file) {
  const img = await rgb(file, ANCHOR_GRID);
  const luma = new Float32Array(img.w * img.h);
  for (let p = 0; p < luma.length; p++) {
    const i = p * img.ch;
    luma[p] = (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
  }
  return { luma, w: img.w, h: img.h };
}

/** Mean luma over the pixels whose centres pass `inside(px, py)` (pixel units), within a bounding box. */
function meanWhere(g, box, inside) {
  let total = 0;
  let n = 0;
  const x0 = Math.max(0, Math.floor(box.x0));
  const x1 = Math.min(g.w, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0));
  const y1 = Math.min(g.h, Math.ceil(box.y1));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      total += g.luma[y * g.w + x];
      n++;
    }
  }
  return { mean: n ? total / n : NaN, n };
}

function discMean(g, cx, cy, r) {
  return meanWhere(g, { x0: cx - r, x1: cx + r, y0: cy - r, y1: cy + r }, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r).mean;
}

// ---------- anchors ----------

async function checkPupil(pupil, file) {
  const g = await lumaGrid(file);
  const r = Math.max(1, PUPIL.radius * g.w);
  const at = discMean(g, pupil.x * g.w, pupil.y * g.h, r);
  const frame = g.luma.reduce((s, v) => s + v, 0) / g.luma.length;
  const dark = at <= PUPIL.black || (at <= PUPIL.maxLuma && at <= frame * PUPIL.maxRatio);
  // The darkest disc in the middle of the frame, to suggest where the anchor should go.
  let best = { v: Infinity, x: 0.5, y: 0.5 };
  for (let y = Math.floor(g.h * 0.2); y < Math.ceil(g.h * 0.8); y++) {
    for (let x = Math.floor(g.w * 0.25); x < Math.ceil(g.w * 0.75); x++) {
      const v = discMean(g, x + 0.5, y + 0.5, r);
      if (v < best.v) best = { v, x: (x + 0.5) / g.w, y: (y + 0.5) / g.h };
    }
  }
  return { at, frame, dark, darkest: best };
}

async function checkPhoto(rect, file) {
  const g = await lumaGrid(file);
  const rx0 = rect.x * g.w;
  const rx1 = (rect.x + rect.w) * g.w;
  const ry0 = rect.y * g.h;
  const ry1 = (rect.y + rect.h) * g.h;
  const ix = rect.w * g.w * PHOTO.inset;
  const iy = rect.h * g.h * PHOTO.inset;
  const inside = meanWhere(g, { x0: rx0 + ix, x1: rx1 - ix, y0: ry0 + iy, y1: ry1 - iy }, () => true).mean;
  const b = PHOTO.band * g.w;
  const inRect = (x, y) => x >= rx0 && x < rx1 && y >= ry0 && y < ry1;
  const ring = meanWhere(g, { x0: rx0 - b, x1: rx1 + b, y0: ry0 - b, y1: ry1 + b }, (x, y) => !inRect(x, y));
  // Without enough pixels around it the rect reaches the frame edge, so there is no border to see.
  const border = ring.n >= 8 ? ring.mean : NaN;
  const lighter = Number.isFinite(border) && Number.isFinite(inside) && border - inside >= PHOTO.minDelta;
  return { inside, border, lighter };
}

// ---------- frames ----------

/** The first or last frame of a clip: the full-size PNG from art:import, else the 1440 frame on disk. */
async function endFrame(chapter, manifest, which, tier) {
  if (!manifest) return null;
  const real = isReal(manifest);
  if (real) {
    const png = workFile(chapter.clip, `.${which}.png`);
    if (await exists(png)) return { file: png, real };
  }
  const count = manifest.tiers?.[tier]?.count ?? chapter.frames;
  const file = frameFile(chapter.clip, tier, which === "first" ? 0 : count - 1);
  return (await exists(file)) ? { file, real } : null;
}

const kind = (f) => (!f ? "missing" : f.real ? "real" : "placeholder");

// ---------- main ----------

async function main() {
  const { chapters, tune, resolveStory, joinWindow } = await loadStory();
  const tier = tune.tiers[0];
  const manifests = new Map();
  for (const c of chapters) manifests.set(c.clip, await readManifest(c.clip));
  const story = resolveStory((clip) => Boolean(manifests.get(clip)));

  console.log(`art:check: the last frame of each clip against the first frame of the next, at ${GRID.w}x${GRID.h}`);
  console.log(
    `mean absolute difference: below ${THRESHOLDS.warn} OK, below ${THRESHOLDS.fail} WARN, otherwise FAIL; centre = the middle third of the width`,
  );
  if (story.skipped.length) console.log(`left out (optional, no frames): ${story.skipped.join(", ")}`);

  // Anchor checks, once per chapter that has anchors.
  const anchors = new Map();
  const anchorRows = [["clip", "anchor", "last frame", "measured", "result"]];
  const anchorNotes = [];
  for (const c of story.chapters) {
    if (!c.anchors.pupil && !c.anchors.photoRect) continue;
    const last = await endFrame(c, manifests.get(c.clip), "last", tier);
    if (!last) {
      anchorRows.push([c.clip, c.anchors.pupil ? "pupil" : "photoRect", "missing", "-", "--"]);
      continue;
    }
    const tag = last.real ? "" : " (placeholder)";
    const result = {};
    if (c.anchors.pupil) {
      const p = c.anchors.pupil;
      const r = await checkPupil(p, last.file);
      result.pupil = r;
      const ok = r.dark ? "OK" : last.real ? "WARN" : "--";
      anchorRows.push([
        c.clip,
        `pupil (${f2(p.x)}, ${f2(p.y)})`,
        rel(last.file),
        `luma ${f2(r.at)} vs frame ${f2(r.frame)}`,
        `${r.dark ? "dark" : "not dark"} ${ok}${tag}`,
      ]);
      if (!r.dark && last.real) {
        const d = r.darkest;
        anchorNotes.push(
          `${c.clip}: the pupil anchor is not on a dark region; the darkest spot near the centre is at (${f2(d.x)}, ${f2(d.y)}), so set anchors.pupil on ${c.id} in src/content/story.ts to { x: ${f2(d.x)}, y: ${f2(d.y)} }`,
        );
      }
    }
    if (c.anchors.photoRect) {
      const rect = c.anchors.photoRect;
      const r = await checkPhoto(rect, last.file);
      result.photo = r;
      const ok = r.lighter ? "OK" : last.real ? "WARN" : "--";
      const border = Number.isFinite(r.border) ? f2(r.border) : "none";
      anchorRows.push([
        c.clip,
        `photoRect (${f2(rect.x)}, ${f2(rect.y)}, ${f2(rect.w)} x ${f2(rect.h)})`,
        rel(last.file),
        `border ${border} vs inside ${f2(r.inside)}`,
        `${r.lighter ? "lighter border" : "no lighter border"} ${ok}${tag}`,
      ]);
      if (last.real) {
        anchorNotes.push(
          r.lighter
            ? `${c.clip}: ends inside the book (lighter border around the photograph), so 'rect' fits${c.join === "rect" ? ", as story.ts has it" : `; set its join to 'rect' in src/content/story.ts`}`
            : `${c.clip}: no lighter border around photoRect, so it seems to end on the full-frame sea: ${c.join === "push" ? "'push' fits, as story.ts has it" : "set its join to 'push' in src/content/story.ts"} (or move photoRect onto the photograph)`,
        );
      }
    }
    anchors.set(c.id, result);
  }

  // Joins.
  const joinRows = [["join", "type", "frames", "whole", "centre", "verdict"]];
  const suggestions = [];
  const count = { OK: 0, WARN: 0, FAIL: 0, unjudged: 0 };
  for (const from of story.chapters) {
    const w = joinWindow(from, story);
    if (!w) continue;
    const { to, type } = w;
    const name = `${from.clip} -> ${to.clip}`;
    const a = await endFrame(from, manifests.get(from.clip), "last", tier);
    const b = await endFrame(to, manifests.get(to.clip), "first", tier);
    const frames = `${kind(a)} / ${kind(b)}`;
    if (!a || !b) {
      joinRows.push([name, type, frames, "-", "-", "--  (run npm run placeholders or npm run art:import)"]);
      count.unjudged++;
      continue;
    }
    const [pa, pb] = await Promise.all([rgb(a.file, GRID), rgb(b.file, GRID)]);
    const whole = mad(pa, pb, WHOLE);
    const centre = mad(pa, pb, CENTRE);
    const ws = grade(whole);
    const cs = grade(centre);
    const raw = worst(ws, cs);
    const anchor = anchors.get(from.id) ?? {};
    const covered =
      (type === "portal" && anchor.pupil?.dark === true) || (type === "rect" && anchor.photo?.lighter === true);

    let verdict;
    if (!a.real || !b.real) {
      verdict = "--  (placeholder, not judged)";
      count.unjudged++;
    } else {
      const v = raw !== "OK" && covered ? "WARN" : raw;
      verdict = v === raw ? v : `${v}  (${type} hides it)`;
      count[v]++;
      if (raw !== "OK") suggestions.push(suggest({ from, to, type, cs, raw, anchor }));
    }
    joinRows.push([name, type, frames, `${f3(whole)} ${ws}`, `${f3(centre)} ${cs}`, verdict]);
  }

  console.log(`\n${table(joinRows)}`);
  if (anchorRows.length > 1) console.log(`\n${table(anchorRows)}`);
  if (anchorNotes.length) console.log(`\n${anchorNotes.join("\n")}`);
  if (suggestions.length) console.log(`\nwhich join fits each mismatched pair:\n${suggestions.map((s) => `  ${s}`).join("\n")}`);

  const judged = count.OK + count.WARN + count.FAIL;
  console.log(
    `\n${judged} join(s) judged: ${count.OK} OK, ${count.WARN} WARN, ${count.FAIL} FAIL` +
      (count.unjudged ? `; ${count.unjudged} not judged (placeholder or missing frames)` : ""),
  );
  if (!judged) console.log("No real clips on both sides of any join yet: add clips to art/source/clips and run npm run art:import.");
  process.exit(count.FAIL ? 1 : 0);
}

/** One line: which join type fits a pair whose frames do not match. */
function suggest({ from, to, type, cs, raw, anchor }) {
  let fit = null;
  let why = "";
  if (from.anchors.photoRect && anchor.photo?.lighter) {
    fit = "rect";
    why = "the photograph has its lighter border, so the rect join grows it over the mismatch";
  } else if (from.anchors.pupil && anchor.pupil?.dark) {
    fit = "portal";
    why = "the pupil is dark, so the portal opens from it over the mismatch";
  } else if (cs === "OK") {
    fit = "push";
    why = "the centre third matches, so the push zoom-blur hides the edges";
  } else if (raw === "WARN") {
    fit = "push";
    why = "a small mismatch is what the 12-frame push dissolve hides";
  }
  const name = `${from.clip} -> ${to.clip}`;
  if (!fit) {
    return `${name}: no join hides this well; regenerate ${to.clip} from ${rel(workFile(from.clip, ".last.png"))} (docs/CHECKS.md), with 'push' as a stopgap`;
  }
  return `${name}: '${fit}' fits (${why})${fit === type ? ", as story.ts has it" : `; story.ts uses '${type}' here`}`;
}

main().catch((err) => {
  console.error(`art:check: ${err?.stack ?? err}`);
  process.exit(2);
});
