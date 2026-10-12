// Shared by tools/art.mjs and tools/art-video.mjs: loads art/prompts.json, expands prompt tokens,
// and knows where every asset lives. No dependencies.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SPEC = JSON.parse(readFileSync(join(ROOT, 'art', 'prompts.json'), 'utf8'));
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'];

export function die(msg, code = 1) {
  console.error(`homeward: ${msg}`);
  process.exit(code);
}

/** Replace {STYLE}, {WALKER}, {REGION} with the blocks in prompts.json. An unknown token is an error. */
export function expand(text) {
  return text.replace(/\{([A-Z]+)\}/g, (m, k) => {
    if (!(k in SPEC.blocks)) die(`unknown token ${m} in a prompt (blocks: ${Object.keys(SPEC.blocks).join(', ')})`);
    return SPEC.blocks[k];
  });
}

export const rel = (p) => p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
const abs = (...p) => join(ROOT, ...p);

function imagePath(dir, id) {
  for (const e of IMAGE_EXT) if (existsSync(abs(dir, `${id}.${e}`))) return abs(dir, `${id}.${e}`);
  return abs(dir, `${id}.png`);
}
function firstExisting(paths) {
  return paths.find((p) => existsSync(p)) || paths[0];
}

/** Every asset in generation order. `path` is the file found, or where it should be saved. */
export function items() {
  const L = SPEC.layout;
  const out = [];
  for (const r of SPEC.refs) out.push({ kind: 'ref', ...r, path: imagePath(L.refs, r.id) });
  for (const k of SPEC.keyframes) out.push({ kind: 'keyframe', ...k, path: imagePath(L.keyframes, k.id) });
  for (const c of SPEC.clips) out.push({ kind: 'clip', ...c, attach: c.refs, path: abs(L.clips, `${c.id}.mp4`) });
  for (const o of SPEC.overlays) out.push({ kind: 'overlay', ...o, attach: [], path: abs(L.overlays, o.file) });
  for (const a of SPEC.audio) {
    out.push({ kind: 'audio', ...a, attach: [], path: firstExisting([abs(L.audio, `${a.for}.m4a`), abs(L.audio, `${a.for}.ogg`)]) });
  }
  const m = SPEC.extras.mark;
  out.push({ kind: 'mark', ...m, attach: [], path: abs('art', 'source', m.file) });
  for (const it of out) it.exists = existsSync(it.path);
  return out;
}

export const byId = (list) => Object.fromEntries(list.map((i) => [i.id, i]));

/** The files to attach to an item. A skipped optional keyframe (K02) is replaced by the frame it follows (K01). */
export function attachments(item, map) {
  return (item.attach || []).map((id) => {
    let t = map[id];
    let via = null;
    if (t && t.optional && !t.exists && t.follows) { via = id; t = map[t.follows]; }
    return { id: t.id, path: t.path, exists: t.exists, via };
  });
}

/** Where a clip's real last frame is kept once exported (the next clip's start frame). */
export const lastFramePath = (clipId) => abs(SPEC.layout.clips, `${clipId}.last.png`);
export const clipPath = (clipId) => abs(SPEC.layout.clips, `${clipId}.mp4`);

/** The clip that ends on the frame this clip starts with (c01 for c02), or null. */
export function chainPrev(clip) {
  return SPEC.clips.find((p) => p.id !== clip.id && p.to === clip.from) || null;
}

/** Match an id: exact, or a unique prefix, or a unique substring. */
export function find(list, q) {
  const s = q.toLowerCase();
  let hits = list.filter((i) => i.id.toLowerCase() === s);
  if (!hits.length) hits = list.filter((i) => i.id.toLowerCase().startsWith(s));
  if (!hits.length) hits = list.filter((i) => i.id.toLowerCase().includes(s));
  if (hits.length === 1) return hits[0];
  if (!hits.length) die(`no asset called '${q}'. Ids: ${list.map((i) => i.id).join(' ')}`, 2);
  die(`'${q}' matches several: ${hits.map((i) => i.id).join(' ')}`, 2);
}
