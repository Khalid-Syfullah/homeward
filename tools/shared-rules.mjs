#!/usr/bin/env node
// Keeps the shared-rules block at the top of every phase prompt identical to prompts/_shared-rules.md.
//   node tools/shared-rules.mjs          rewrite the block in every prompts/NN-*.md
//   node tools/shared-rules.mjs --check  exit 1 if any file is out of date (changes nothing)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/spec.mjs';

const dir = join(ROOT, 'prompts');
const rules = readFileSync(join(dir, '_shared-rules.md'), 'utf8').trim();
const START = '<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->';
const END = '<!-- shared-rules:end -->';
const check = process.argv.includes('--check');
let stale = 0;
for (const f of readdirSync(dir).filter((n) => /^\d\d.*\.md$/.test(n)).sort()) {
  const p = join(dir, f);
  const text = readFileSync(p, 'utf8');
  const a = text.indexOf('<!-- shared-rules:start');
  const b = text.indexOf(END);
  if (a < 0 || b < a) { console.log(`MISSING  ${f}: no shared-rules markers`); stale++; continue; }
  const next = text.slice(0, a) + `${START}\n${rules}\n${END}` + text.slice(b + END.length);
  if (next === text) { console.log(`ok       ${f}`); continue; }
  stale++;
  if (check) console.log(`STALE    ${f}`);
  else { writeFileSync(p, next); console.log(`updated  ${f}`); }
}
process.exit(check && stale ? 1 : 0);
