# Homeward

A scroll-driven film in ten clips. The visitor's scroll plays it forward and back, and every clip ends on the frame the next one begins with, so one camera seems to travel from a road, through an eye, down into a house, into a book, out to sea and up to the sky.

This repository holds everything needed to make it: the prompts for every image, video and sound asset, the eight prompts that build the website, and a Claude Code skill that runs them in order.

```
/build-homeward         run the art status, then every remaining website phase
/build-homeward next    one phase
/build-homeward only 4  exactly one phase (a number, a name, or part of a name)
/build-homeward art     only the art step
/build-homeward status  where things stand
```

## Start

1. **The art.** `node tools/art.mjs status` lists all 38 required assets in the order to make them. Three ways to make them, and you can mix:
   - Let Claude do it: `/build-homeward art`. It uses an image or video tool connected to your session, or `tools/art-video.mjs` (Veo through the Gemini API; needs your key in `.env.art`, always a dry run until you say yes).
   - By hand with your own subscriptions: `node tools/art.mjs sheet` writes `art/PROMPT-SHEET.md` with every prompt expanded, in order, with the files to attach and where to save each one. `node tools/art.mjs prompt K03 --copy` copies a single prompt.
   - Not yet: the site builds and runs on generated placeholders.
2. **The site.** Open Claude Code in this folder and run `/build-homeward`. Each of the eight phases in `prompts/` is built by a subagent on the model in `prompts/models.conf`, checked (lint, typecheck, build), then committed with the message in its `.commit` file and pushed. Progress is kept in `logs/`, so a stopped run resumes where it left off.
3. **Real art in.** Drop files into `art/source/` (see `docs/EXPORT.md`). Phase 2 creates `npm run art:import` and `npm run art:check`; run them whenever art changes.

Without the skill, paste `prompts/01-…md`, then `02-…`, and so on into fresh Claude Code sessions. Each file carries the shared rules at its top.

## What is where

| Path | What |
| --- | --- |
| `docs/PLAN.md` | The idea, the order of work, the shot list |
| `docs/STYLE-BIBLE.md` | Palette, camera rules, consistency kit |
| `docs/IMAGE-PROMPTS.md` | Reference images A0 to A2 and keyframes K01 to K12 (generated from `art/prompts.json`) |
| `docs/VIDEO-PROMPTS.md` | The ten clip prompts and plan B for c08 (generated) |
| `docs/EXTRA-ASSETS.md` | Overlays, sound, phone re-frame, poster, mark (generated) |
| `docs/EXPORT.md` | Folder layout, the ffmpeg commands, the frame budget |
| `docs/ARCHITECTURE.md` | How the site plays the clips |
| `docs/COPY.md` | The placeholder words on screen |
| `docs/CHECKS.md` | How to judge each clip, what to do when it fails |
| `docs/PERF.md` | The performance budget, measured (`npm run perf`), and the browser tests (`npm test`) |
| `art/prompts.json` | Every asset prompt, the four style blocks, settings. The single source |
| `prompts/` | The eight website phases, their commit messages, `models.conf` |
| `tools/` | `art.mjs` (status, prompt, sheet, docs), `art-video.mjs` (Veo clips, takes, chaining), `shared-rules.mjs` |
| `.claude/` | The `build-homeward` skill and its three phase agents |
| `scripts/`, `src/` | Created by the site phases |
| `tests/`, `playwright.config.ts` | Browser tests: scrubbing, joins, anchors, phones, reduced motion, keyboard (`npm test`) |

## Cost and models

- Clips through `art-video.mjs`: each take is 8 seconds. At the default (Veo 3.1 Fast, 1080p, $0.12 per second) that is $0.96 a take: nine clips once is $8.64, and the plan's three takes each is about $26 (27 takes). Prices are for preview models and change; the script prints the estimate and never sends anything without `--yes`.
- Images and sound use whatever generators you have; nothing here spends money on them unless you connect one and say yes.
- Website phases: `prompts/models.conf` sets the model and effort per phase (Fable for the shader work in phase 4, Opus for the rest of the engine and the final pass, Sonnet for the chapters). If Fable is not on your account change line 04 to `04 opus max`.

## Changing things

- Prompts or the look: edit `art/prompts.json` (the `blocks` hold STYLE, WALKER, REGION and NEGATIVE; change REGION to your own place and every prompt follows), then `node tools/art.mjs docs`.
- Shared rules for the site phases: edit `prompts/_shared-rules.md`, then `node tools/shared-rules.mjs`.
- Both have `--check` modes that exit 1 when a file is stale: `node tools/art.mjs docs --check && node tools/shared-rules.mjs --check`.
- Skill settings (no push, a different check command): copy `.claude/skills/build-homeward/config.env.example` to `config.env` in the same folder.

## Deploying

`public/frames/` and `public/audio/` are git-ignored because they are generated. To deploy from git, remove those two lines from `.gitignore` after the final import (about 50 MB of frames at full art), or serve the frames from object storage. The site needs them at runtime. `public/frames` should get long immutable cache headers; rename a clip's folder to bust it.
