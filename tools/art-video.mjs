#!/usr/bin/env node
// Makes the ten Homeward clips with Veo through the Gemini API, chaining each clip from the real last
// frame of the one before it. It spends the owner's Google API money, so it is a dry run unless --yes.
//
//   node tools/art-video.mjs                         dry run: which clips can be made now, how many takes, the estimate
//   node tools/art-video.mjs --only c01 --yes        make one clip (do this first; --only takes ids or prefixes: c01,c02-eye)
//   node tools/art-video.mjs --yes                   make every clip that can be made, in order, chaining as it goes
//   node tools/art-video.mjs --only c01 --takes 3 --yes   three takes (c01-follow.take1.mp4 ...); look, then --pick
//   node tools/art-video.mjs --sheet c01             contact sheet of every take: art/source/clips/c01-follow.sheet.png
//   node tools/art-video.mjs --pick c01 2            take 2 becomes c01-follow.mp4 and its last frame is exported
//   node tools/art-video.mjs --last c01              export the real last frame of c01-follow.mp4 (the next clip's start frame)
//
// Options
//   --takes N            takes per clip (default 1: the clip is final at once). With N > 1 the run stops after each clip
//                        until you --pick, because the next clip must start from the take you chose.
//   --plan-b c08         use the clip's plan B prompt (start frame only) where it has one (docs/CHECKS.md)
//   --include-optional   also make c03-portal (skipped by default; the site's portal join does that hand-off)
//   --model fast|lite|standard   default fast        --resolution 720p|1080p   default 1080p
//   --max-usd N          refuse to run when the estimate is higher (default 10)
//   --force              make a clip again even when its file exists
//   --show-prompts       print the exact prompt each clip would send
//   --yes                actually spend money (without it nothing is sent)
//
// Key: GEMINI_API_KEY in the environment or in .env.art (git-ignored). It is never printed or committed.
// Needs Node 18+ and ffmpeg/ffprobe on PATH. No npm dependencies.
// Veo makes 4, 6 or 8 s clips, and a clip with both a first and a last frame must be 8 s, so every clip is 8 s here;
// the "film seconds" in the plan are targets, and a shorter clip simply plays faster against the same scroll.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, SPEC, die, expand, items, byId, rel, find, chainPrev, lastFramePath, clipPath } from './lib/spec.mjs';

const BASE = process.env.HOMEWARD_VEO_BASE || 'https://generativelanguage.googleapis.com/v1beta'; // the override is for tests
const POLL_MS = Number(process.env.HOMEWARD_POLL_MS) || 10000;
// USD per second of video, from ai.google.dev/gemini-api/docs/pricing (checked 2026-10-12). Preview models: check again before a big run.
const MODELS = {
  fast: { id: 'veo-3.1-fast-generate-preview', usd: { '720p': 0.1, '1080p': 0.12 } },
  lite: { id: 'veo-3.1-lite-generate-preview', usd: { '720p': 0.05, '1080p': 0.08 } },
  standard: { id: 'veo-3.1-generate-preview', usd: { '720p': 0.4, '1080p': 0.4 } },
};
const SECONDS = SPEC.settings.video.veoSeconds;
const CLIPS_DIR = join(ROOT, SPEC.layout.clips);
const TMP = join(ROOT, 'art', 'work', 'tmp-video');

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const model = MODELS[opt('model', 'fast')] || die('--model must be fast, lite or standard', 2);
const resolution = opt('resolution', SPEC.settings.video.resolution);
if (!model.usd[resolution]) die('--resolution must be 720p or 1080p', 2);
const maxUsd = Number(opt('max-usd', '10'));
const takes = Math.max(1, Math.min(4, parseInt(opt('takes', '1'), 10) || 1));
const yes = flag('yes');
const force = flag('force');
const clipList = SPEC.clips;
const clipById = byId(clipList);
const matchClip = (q) => find(clipList, q);

// ---------- ffmpeg ----------
function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error) die(`${bin} not found on PATH (${r.error.message}). Install ffmpeg first.`);
  if (r.status !== 0) die(`${bin} failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
  return r.stdout.trim();
}
const ffmpeg = (args) => run('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const duration = (file) => parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));

/** Export a clip's real last frame (the same method as docs/EXPORT.md): seek near the end and keep overwriting one file. */
function exportLast(clipId) {
  const mp4 = clipPath(clipId);
  if (!existsSync(mp4)) die(`${rel(mp4)} does not exist yet`);
  const out = lastFramePath(clipId);
  ffmpeg(['-sseof', '-1', '-i', mp4, '-update', '1', out]);
  return out;
}
function freshLast(clipId) {
  const out = lastFramePath(clipId);
  if (existsSync(out) && existsSync(clipPath(clipId)) && statMtime(out) >= statMtime(clipPath(clipId))) return out;
  return exportLast(clipId);
}
const statMtime = (p) => statSync(p).mtimeMs;

/** A frame, conformed to exactly 1920x1080 (cover crop) so every request is the same shape and size. */
function conform(file, name) {
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, `${name}.png`);
  ffmpeg(['-i', file, '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080', '-frames:v', '1', out]);
  return out;
}

// ---------- plan ----------
const list = items();
const map = byId(list);
const takeFiles = (id) => !existsSync(CLIPS_DIR) ? [] : readdirSync(CLIPS_DIR, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  .filter((n) => new RegExp(`^${id}\\.take\\d+\\.mp4$`).test(n)).sort();
const planBIds = opt('plan-b', '') ? opt('plan-b', '').split(',').map((q) => matchClip(q).id) : [];
const onlyIds = opt('only', '') ? opt('only', '').split(',').map((q) => matchClip(q).id) : null;

function startOf(c, willMake) {
  // chain from the previous clip when it exists (or is made earlier in this run), otherwise from the keyframe
  const prev = chainPrev(c);
  if (prev && (existsSync(clipPath(prev.id)) || willMake.has(prev.id))) return { kind: 'chain', id: prev.id, ok: true };
  const kf = map[c.from];
  return { kind: 'keyframe', id: kf.id, ok: kf.exists, path: kf.path };
}

function plan() {
  const todo = [], skipped = [], willMake = new Set();
  let blockedBy = null;
  for (const c of clipList) {
    if (onlyIds && !onlyIds.includes(c.id)) continue;
    if (existsSync(clipPath(c.id)) && !force) { skipped.push([c.id, `${rel(clipPath(c.id))} exists (--force to make it again)`]); continue; }
    if (c.optional && !flag('include-optional') && !(onlyIds && onlyIds.includes(c.id))) { skipped.push([c.id, 'optional (add --include-optional, or name it with --only)']); continue; }
    const pending = takeFiles(c.id);
    if (pending.length && !force) { skipped.push([c.id, `${pending.length} take(s) waiting: look with --sheet ${c.id}, then --pick ${c.id} <n>`]); blockedBy = c.id; continue; }
    const usePlanB = planBIds.includes(c.id);
    if (usePlanB && !c.planB) die(`${c.id} has no plan B`, 2);
    const end = map[c.to];
    const start = startOf(c, willMake);
    const prev = chainPrev(c);
    if (blockedBy && prev && prev.id === blockedBy) { skipped.push([c.id, `wait: pick ${blockedBy} first (this clip starts from its last frame)`]); continue; }
    const missing = [];
    if (!start.ok) missing.push(start.kind === 'keyframe' ? `${start.id}.png` : `the clip ${start.id}`);
    if (!(usePlanB && c.planB.startOnly) && !end.exists) missing.push(`${end.id}.png`);
    if (missing.length) { skipped.push([c.id, `needs ${missing.join(', ')} in art/source/ first`]); continue; }
    todo.push({ c, start, usePlanB });
    if (takes === 1) willMake.add(c.id); else blockedBy = c.id;
  }
  if (takes > 1 && todo.length > 1) { for (const t of todo.splice(1)) skipped.push([t.c.id, 'later: with several takes the run stops after each clip until you pick one']); }
  return { todo, skipped };
}

// ---------- key ----------
function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const f = join(ROOT, '.env.art');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return '';
}

// ---------- Veo ----------
const imagePart = (path, shape) => {
  const data = readFileSync(path).toString('base64');
  return shape === 'inlineData' ? { inlineData: { mimeType: 'image/png', data } } : { bytesBase64Encoded: data, mimeType: 'image/png' };
};
async function api(path, key, init = {}) {
  const res = await fetch(`${BASE}/${path}`, { ...init, headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}
const veoPrompt = (c, planB) => `${expand(planB ? c.planB.prompt : c.prompt)}\n\nOne continuous shot, no text, no captions, no music.`;

let negOk = true;
async function generate(c, firstPng, lastPng, planB, key) {
  const prompt = veoPrompt(c, planB);
  // try the documented request shape first; on a 400 fall back to fewer optional fields
  const attempts = [{ shape: 'inlineData', neg: negOk }, { shape: 'inlineData', neg: false }, { shape: 'bytes', neg: false }].filter((x, i, arr) => i === 0 || x.neg !== arr[i - 1].neg || x.shape !== arr[i - 1].shape);
  let started;
  for (const [i, a] of attempts.entries()) {
    const instance = { prompt, image: imagePart(firstPng, a.shape) };
    if (lastPng) instance.lastFrame = imagePart(lastPng, a.shape);
    const parameters = { aspectRatio: '16:9', resolution, durationSeconds: SECONDS, personGeneration: 'allow_adult' };
    if (a.neg) parameters.negativePrompt = SPEC.blocks.NEGATIVE;
    started = await api(`models/${model.id}:predictLongRunning`, key, { method: 'POST', body: JSON.stringify({ instances: [instance], parameters }) });
    if (started.ok) { if (!a.neg) negOk = false; break; } // remember that this model rejects negativePrompt
    if (started.status !== 400 || i === attempts.length - 1) throw new Error(`start failed (${started.status}): ${started.text.slice(0, 600)}`);
  }
  const name = started.json?.name;
  if (!name) throw new Error(`no operation name: ${started.text.slice(0, 300)}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    const op = await api(name, key);
    if (!op.ok) throw new Error(`poll failed (${op.status}): ${op.text.slice(0, 300)}`);
    if (op.json?.done) {
      if (op.json.error) throw new Error(`generation failed: ${JSON.stringify(op.json.error).slice(0, 400)}`);
      const r = op.json.response?.generateVideoResponse;
      const uri = r?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error(`no video returned${r?.raiMediaFilteredReasons ? ` (filtered by the safety system: ${r.raiMediaFilteredReasons.join('; ')}; edit the prompt, for example fewer or smaller people in c09)` : ''}`);
      return uri;
    }
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('timed out after 15 minutes');
    process.stdout.write('.');
  }
}
async function download(uri, key, dest) {
  const res = await fetch(uri, { headers: { 'x-goog-api-key': key }, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ---------- small commands ----------
if (flag('last')) {
  const c = matchClip(opt('last', ''));
  console.log(`exported ${rel(exportLast(c.id))}`);
  process.exit(0);
}
if (flag('pick')) {
  const i = argv.indexOf('--pick');
  const c = matchClip(argv[i + 1] || '');
  const n = parseInt(argv[i + 2], 10);
  const src = join(CLIPS_DIR, `${c.id}.take${n}.mp4`);
  if (!n || !existsSync(src)) die(`no ${rel(src)}. Takes: ${takeFiles(c.id).join(' ') || 'none'}`, 2);
  copyFileSync(src, clipPath(c.id));
  const side = join(CLIPS_DIR, `${c.id}.take${n}.json`);
  if (existsSync(side)) copyFileSync(side, join(CLIPS_DIR, `${c.id}.json`));
  const out = exportLast(c.id);
  console.log(`picked take ${n} -> ${rel(clipPath(c.id))}\nexported ${rel(out)} (the next clip starts from it)`);
  process.exit(0);
}
if (flag('sheet')) {
  const c = matchClip(opt('sheet', ''));
  const files = takeFiles(c.id).map((n) => join(CLIPS_DIR, n));
  if (existsSync(clipPath(c.id)) && !files.length) files.push(clipPath(c.id));
  if (!files.length) die(`no takes or clip for ${c.id} in ${SPEC.layout.clips}/`, 2);
  mkdirSync(TMP, { recursive: true });
  const strips = files.map((f, k) => {
    const out = join(TMP, `strip${k}.png`);
    ffmpeg(['-i', f, '-vf', `fps=6/${duration(f).toFixed(3)},scale=320:-2,tile=6x1`, '-frames:v', '1', out]);
    return out;
  });
  const sheet = join(CLIPS_DIR, `${c.id}.sheet.png`);
  if (strips.length === 1) copyFileSync(strips[0], sheet);
  else ffmpeg([...strips.flatMap((s) => ['-i', s]), '-filter_complex', `vstack=inputs=${strips.length}`, sheet]);
  rmSync(TMP, { recursive: true, force: true });
  console.log(`wrote ${rel(sheet)}: one row per take (${files.map((f) => f.split('/').pop()).join(', ')}), six frames each, first to last`);
  process.exit(0);
}

// ---------- run ----------
const { todo, skipped } = plan();
for (const [id, why] of skipped) console.log(`skip   ${id}: ${why}`);
const rate = model.usd[resolution];
const total = todo.length * takes * SECONDS * rate;
console.log(`\nmodel ${model.id}, ${resolution}, ${SECONDS} s per take, $${rate.toFixed(2)}/s, ${takes} take(s) per clip`);
for (const { c, start, usePlanB } of todo) {
  console.log(`  ${c.id.padEnd(14)} start: ${start.kind === 'chain' ? `last frame of ${start.id}` : `${start.id}.png`}  end: ${usePlanB ? 'none (plan B)' : `${c.to}.png`}   $${(takes * SECONDS * rate).toFixed(2)}`);
}
console.log(`estimate: ${todo.length} clip(s), $${total.toFixed(2)} (you are charged only for takes that succeed)\n`);
if (flag('show-prompts')) for (const { c, usePlanB } of todo) console.log(`--- ${c.id}\n${veoPrompt(c, usePlanB)}\n--- negative\n${SPEC.blocks.NEGATIVE}\n`);
if (!todo.length) process.exit(0);
if (total > maxUsd) die(`estimate $${total.toFixed(2)} is over --max-usd ${maxUsd}`, 2);
if (!yes) { console.log('Dry run: nothing was sent. Add --yes to generate.'); process.exit(0); }

const key = loadKey();
if (!key) die('no key: set GEMINI_API_KEY or put it in .env.art (copy .env.art.example)', 2);
mkdirSync(CLIPS_DIR, { recursive: true });

let failed = 0;
const made = new Set();
for (const { c, usePlanB } of todo) {
  // resolve the start frame now: a clip made earlier in this run has its real last frame available
  const prev = chainPrev(c);
  let startFile, startLabel;
  if (prev && existsSync(clipPath(prev.id))) { startFile = freshLast(prev.id); startLabel = `chain:${prev.id}`; }
  else { startFile = map[c.from].path; startLabel = c.from; }
  if (!existsSync(startFile)) { console.log(`skip   ${c.id}: its start frame ${rel(startFile)} is missing`); continue; }
  const first = conform(startFile, `${c.id}-first`);
  const last = usePlanB && c.planB.startOnly ? null : conform(map[c.to].path, `${c.id}-last`);
  process.stdout.write(`make   ${c.id} (${takes} take${takes > 1 ? 's' : ''}) `);
  const results = await Promise.allSettled(Array.from({ length: takes }, async (_, k) => {
    const uri = await generate(c, first, last, usePlanB, key);
    const n = k + 1;
    const final = takes === 1 ? clipPath(c.id) : join(CLIPS_DIR, `${c.id}.take${n}.mp4`);
    const part = `${final}.part`;
    await download(uri, key, part);
    ffmpeg(['-i', part, '-an', '-c:v', 'copy', '-f', 'mp4', final]); // drop Veo's audio track
    rmSync(part, { force: true });
    const meta = { model: model.id, resolution, seconds: SECONDS, aspect: '16:9', planB: usePlanB, start: startLabel, end: last ? c.to : null, generated: new Date().toISOString() };
    writeFileSync(takes === 1 ? join(CLIPS_DIR, `${c.id}.json`) : join(CLIPS_DIR, `${c.id}.take${n}.json`), JSON.stringify(meta, null, 2));
    return final;
  }));
  const ok = results.filter((r) => r.status === 'fulfilled');
  results.filter((r) => r.status === 'rejected').forEach((r) => console.log(`\n   FAILED: ${r.reason.message}`));
  failed += results.length - ok.length;
  if (!ok.length) { console.log(' no take succeeded; stopping so the chain does not skip a clip'); break; }
  if (takes === 1) { exportLast(c.id); made.add(c.id); console.log(` ok -> ${rel(clipPath(c.id))} (+ ${rel(lastFramePath(c.id))})`); }
  else { console.log(` ${ok.length} take(s) saved. Look: node tools/art-video.mjs --sheet ${c.id}   then: node tools/art-video.mjs --pick ${c.id} <n>`); break; }
}
rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} take(s) failed; run again to redo only what is missing.` : '\nDone. Next: node tools/art.mjs status');
process.exit(failed ? 1 : 0);
