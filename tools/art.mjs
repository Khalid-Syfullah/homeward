#!/usr/bin/env node
// Homeward asset helper. Reads art/prompts.json (the single source of every prompt). No dependencies.
//
//   node tools/art.mjs status [--json]       every asset in generation order: have / missing, and what to make next
//   node tools/art.mjs prompt <id> [--copy] [--plain] [--plan-b]
//                                            one prompt, fully expanded, with the files to attach (id: K03, c04, dust, sound-c01 ...)
//   node tools/art.mjs sheet [--out FILE]    every prompt in order as one file (default art/PROMPT-SHEET.md) to work through by hand
//   node tools/art.mjs docs [--check]        rewrite docs/IMAGE-PROMPTS.md, VIDEO-PROMPTS.md and EXTRA-ASSETS.md from prompts.json
//   node tools/art.mjs blocks                print the STYLE, WALKER, REGION and NEGATIVE blocks

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { ROOT, SPEC, die, expand, items, byId, attachments, rel, find, chainPrev, lastFramePath } from './lib/spec.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const KIND_LABEL = { ref: 'reference image', keyframe: 'keyframe image', clip: 'video clip', overlay: 'overlay', audio: 'sound', mark: 'mark' };
const mark = (ok) => (ok ? '✓' : '·');

// ---------------------------------------------------------------- status
function status() {
  const list = items();
  const next = list.find((i) => !i.exists && !i.optional);
  if (flag('json')) {
    console.log(JSON.stringify({ next: next ? next.id : null, items: list.map((i) => ({ id: i.id, kind: i.kind, exists: i.exists, optional: !!i.optional, path: rel(i.path) })) }, null, 2));
    return;
  }
  console.log('Homeward assets (generation order). ✓ = file found in art/source/, · = missing\n');
  let kind = '';
  for (const i of list) {
    if (i.kind !== kind) { kind = i.kind; console.log(`${KIND_LABEL[kind].toUpperCase()}S`); }
    const extra = i.kind === 'clip' ? `${i.from} → ${i.to}${i.optional ? '  (optional)' : ''}` : i.kind === 'keyframe' && i.optional ? '(optional)' : '';
    console.log(`  ${mark(i.exists)} ${i.id.padEnd(14)} ${rel(i.path).padEnd(46)} ${extra}`);
  }
  const need = list.filter((i) => !i.optional);
  const have = need.filter((i) => i.exists).length;
  console.log(`\n${have}/${need.length} required assets present` + (next ? `. Next: ${next.id}  →  node tools/art.mjs prompt ${next.id}` : '. Everything required is in place: run the site phases (prompts/02) to import it.'));
}

// ---------------------------------------------------------------- prompt text
function startFrameInfo(clip, map) {
  const prev = chainPrev(clip);
  const kf = map[clip.from];
  if (prev) {
    const last = lastFramePath(prev.id);
    return { text: `${rel(last)} (the real last frame of ${prev.id}; export it with: node tools/art-video.mjs --last ${prev.id})  [${existsSync(last) ? 'found' : 'not exported yet'}]`, fallback: `${rel(kf.path)} [${kf.exists ? 'found' : 'missing'}] if ${prev.id} is not made` };
  }
  return { text: `${rel(kf.path)} [${kf.exists ? 'found' : 'missing'}]` };
}

function describe(item, map, { planB = false } = {}) {
  const lines = [];
  const head = item.kind === 'clip' ? `${item.id} · ${item.seconds} s target · ${item.from} to ${item.to}${item.optional ? ' · optional' : ''}` : `${item.id}${item.title ? ' · ' + item.title : ''}`;
  lines.push(head, `Save as: ${rel(item.path)}`);
  if (item.kind === 'clip') {
    const s = startFrameInfo(item, map);
    lines.push(`Start frame: ${s.text}`);
    if (s.fallback) lines.push(`             otherwise ${s.fallback}`);
    const planBOk = planB && item.planB;
    lines.push(planBOk ? 'End frame: none (plan B uses the start frame only)' : `End frame: ${rel(map[item.to].path)} [${map[item.to].exists ? 'found' : 'missing'}]`);
    const refs = attachments(item, map);
    if (refs.length) lines.push(`References (where the tool accepts them): ${refs.map((r) => `${r.id} [${r.exists ? 'found' : 'missing'}]`).join(', ')}`);
    const v = SPEC.settings.video;
    lines.push(`Settings: ${v.fps} fps, ${v.resolution} or better, longest length your tool offers, ${v.takesPerClip} takes, pick with docs/CHECKS.md`);
  } else if (item.kind === 'ref' || item.kind === 'keyframe') {
    const att = attachments(item, map);
    const extra = item.attachNote ? ` (${item.attachNote})` : '';
    lines.push(att.length ? `Attach: ${att.map((a) => `${a.id}${a.via ? ` (stands in for ${a.via})` : ''} [${a.exists ? 'found' : 'missing'}]`).join(', ')}${extra}` : 'Attach: nothing');
    lines.push(`Size: ${SPEC.settings.imageAspect}, ${SPEC.settings.imageSize} ideal, ${SPEC.settings.imageMinSize} minimum. Variants: ${SPEC.settings.variantsPerFrame}; keep the one whose centre third best matches its neighbour.`);
  } else if (item.kind === 'overlay') {
    lines.push(`Used in: ${item.usedIn}`, `Spec: ${item.spec}`);
  } else if (item.kind === 'audio') {
    lines.push(`Length: ${item.length}`, 'Make an .m4a (AAC); an .ogg copy of the same name is the fallback.');
  }
  if (item.note) lines.push(`Note: ${item.note}`);
  return lines.join('\n');
}

function promptText(item, { planB = false } = {}) {
  if (planB) {
    if (!item.planB) die(`${item.id} has no plan B`, 2);
    return expand(item.planB.prompt);
  }
  return expand(item.prompt);
}

function copyToClipboard(text) {
  for (const [bin, args] of [['pbcopy', []], ['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['clip.exe', []]]) {
    const r = spawnSync(bin, args, { input: text });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

function prompt() {
  const q = argv[1];
  if (!q || q.startsWith('--')) die('usage: node tools/art.mjs prompt <id> [--copy] [--plain] [--plan-b]   (ids: node tools/art.mjs status)', 2);
  const list = items();
  const map = byId(list);
  const item = find(list, q);
  const planB = flag('plan-b');
  const text = promptText(item, { planB });
  if (flag('plain')) { console.log(text); }
  else {
    console.log(describe(item, map, { planB }));
    console.log('\n--- PROMPT ---\n' + text);
    if (item.kind === 'clip') console.log('\n--- NEGATIVE (use the negative field if your tool has one) ---\n' + SPEC.blocks.NEGATIVE);
    if (item.kind === 'clip' && item.planB && !planB) console.log('\n(This clip has a plan B: node tools/art.mjs prompt ' + item.id + ' --plan-b)');
  }
  if (flag('copy')) {
    const used = copyToClipboard(text);
    console.error(used ? `\ncopied the prompt to the clipboard (${used})` : '\nno clipboard tool found; copy the prompt above');
  }
}

// ---------------------------------------------------------------- sheet
function sheet() {
  const list = items();
  const map = byId(list);
  const out = opt('out', join(ROOT, 'art', 'PROMPT-SHEET.md'));
  const L = ['# Homeward: prompt sheet', '', 'Generated by `node tools/art.mjs sheet`. Every prompt is expanded and in the order to make them. Work top to bottom; tick the box when the file is saved at the path shown. Check each pair against docs/CHECKS.md before moving on.', ''];
  let kind = '';
  for (const i of list) {
    if (i.kind !== kind) { kind = i.kind; L.push(`## ${KIND_LABEL[kind][0].toUpperCase() + KIND_LABEL[kind].slice(1)}s`, ''); }
    L.push(`### [${i.exists ? 'x' : ' '}] ${i.id}${i.title ? ' · ' + i.title : ''}`, '', '```text', describe(i, map), '```', '', 'Prompt:', '', '```text', promptText(i), '```', '');
    if (i.kind === 'clip') L.push('Negative:', '', '```text', SPEC.blocks.NEGATIVE, '```', '');
    if (i.kind === 'clip' && i.planB) L.push('Plan B (start frame only):', '', '```text', promptText(i, { planB: true }), '```', '');
  }
  L.push('## Phone re-frame (only if the 16:9 crop disappoints)', '', '```text', SPEC.extras.phoneReframe, '```', '');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, L.join('\n'));
  console.log(`wrote ${rel(out)} (${list.length} assets)`);
}

// ---------------------------------------------------------------- docs
const fenceText = (t) => '```text\n' + t + '\n```';
const GEN = '<!-- Generated by `node tools/art.mjs docs` from art/prompts.json. Edit the JSON, not this file. -->';

function attachLine(k, map) {
  if (!k.attach.length) return 'Attach: nothing.' + (k.id === 'A0' ? ' Every frame with the man uses this.' : '');
  const names = k.attach.map((id) => {
    const t = map[id];
    return t && t.optional ? `${id} (${t.follows} if you skipped ${id})` : id;
  });
  return `Attach: ${names.join(', ')}${k.attachNote ? ` (${k.attachNote})` : ''}.`;
}

function docImages() {
  const map = byId(items());
  const D = SPEC.docs;
  const L = [GEN, '', '# Homeward: image prompts', '', D.imageIntro, '', '## Prompt blocks', ''];
  for (const b of ['STYLE', 'WALKER', 'REGION', 'NEGATIVE']) L.push(`### ${b}`, '', fenceText(SPEC.blocks[b]), '');
  L.push('## Reference images and keyframes', '');
  for (const k of [...SPEC.refs, ...SPEC.keyframes]) {
    L.push(`### ${k.id} · ${k.title}`, '', attachLine(k, map), '', fenceText(k.prompt), '');
    if (k.note && k.id !== 'A0') L.push(k.note, '');
  }
  L.push(D.imageOutro, '');
  return L.join('\n');
}

function docVideos() {
  const D = SPEC.docs;
  const L = [GEN, '', '# Homeward: video prompts', '', D.videoIntro, ''];
  for (const c of SPEC.clips) {
    L.push(`### ${c.id}${c.optional ? ' (optional)' : ''} · ${c.seconds} s${c.id === 'c04-descent' ? ' (8 if your tool caps there)' : ''} · ${c.from} to ${c.to}`, '');
    if (c.note) L.push(c.note, '');
    L.push(c.refs.length ? `References: ${c.refs.join(', ')} where the tool accepts them.` : 'References: none needed.', '', fenceText(c.prompt), '');
    if (c.planB) L.push(`**Plan B.** ${c.planB.note}`, '', fenceText(c.planB.prompt), '');
  }
  return L.join('\n');
}

function docExtras() {
  const D = SPEC.docs;
  const L = [GEN, '', '# Homeward: extra assets', '', D.extrasIntro, '', '## Overlays', '', D.overlaysIntro, '', '| File | Used in | Prompt | Spec |', '| --- | --- | --- | --- |'];
  for (const o of SPEC.overlays) L.push(`| ${o.file} | ${o.usedIn} | ${o.prompt} | ${o.spec} |`);
  L.push('', '## Sound', '', D.soundIntro, '', '| Clip | Prompt | Length |', '| --- | --- | --- |');
  for (const a of SPEC.audio) L.push(`| ${a.for} | ${a.prompt} | ${a.length} |`);
  L.push('', '## Phones', '', D.phonesIntro, '', fenceText(SPEC.extras.phoneReframe), '', '## Poster, share image and mark', '');
  for (const e of SPEC.extras.exports) { const i = e.indexOf(': '); L.push(`- **${e.slice(0, i)}:** ${e.slice(i + 2)}`); }
  L.push(`- **Mark:** ${SPEC.extras.mark.prompt} ${SPEC.extras.mark.note}`, '');
  return L.join('\n');
}

function docs() {
  const files = { 'IMAGE-PROMPTS.md': docImages(), 'VIDEO-PROMPTS.md': docVideos(), 'EXTRA-ASSETS.md': docExtras() };
  let stale = 0;
  for (const [name, text] of Object.entries(files)) {
    const p = join(ROOT, 'docs', name);
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (cur === text) { console.log(`ok       docs/${name}`); continue; }
    stale++;
    if (flag('check')) console.log(`STALE    docs/${name}`);
    else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); console.log(`wrote    docs/${name}`); }
  }
  if (flag('check') && stale) process.exit(1);
}

// ---------------------------------------------------------------- main
switch (cmd) {
  case 'status': status(); break;
  case 'prompt': prompt(); break;
  case 'sheet': sheet(); break;
  case 'docs': docs(); break;
  case 'blocks': for (const [k, v] of Object.entries(SPEC.blocks)) console.log(`${k}\n${v}\n`); break;
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd === 'help' ? 0 : 2);
}
