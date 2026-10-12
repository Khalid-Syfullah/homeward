---
name: build-homeward
description: Build the Homeward scroll film end to end. Makes the art (reference images, keyframes, ten Veo clips, overlays, sound) from art/prompts.json when a generator is available, and runs the eight website prompts in prompts/ one phase at a time, each on its assigned model and effort, with a build check and a commit and push per phase. Use only when the user runs /build-homeward or asks to continue the Homeward build, run one named phase, or make the Homeward art.
argument-hint: "[next | only <phase> | status | reset | art [id]]"
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/phase.sh *) Bash(git status *) Bash(git log *) Bash(ls art/*) Bash(node tools/art.mjs *) Bash(node tools/art-video.mjs) Bash(node tools/art-video.mjs *) Bash(node tools/shared-rules.mjs *)
---

# build-homeward

You are the coordinator. You do not write site code yourself: each phase is built by a subagent running on the model assigned to that phase. Progress lives on disk (`logs/`), so the run can stop, hit a usage limit, or be compacted and still resume at the right phase.

The project is a ten-clip scroll film (a road, an eye, a valley, a house, a book, a sea, a shore, the sky). `docs/PLAN.md` explains it. The site runs on generated placeholders, so the build never waits for art.

Mode requested: `$ARGUMENTS`
- empty: run the art status, then every remaining website phase, in order
- `next`: run only the next unfinished phase, then stop
- `only <phase>`: run exactly the one phase named, then stop (see "Only mode"). `<phase>` is its number (`4`), its name (`04-the-three-joins`) or a unique part of the name (`joins`). It works on a pending phase and on a finished one (a finished phase is re-run over its existing code).
- `status`: run `phase.sh status`, then `node tools/art.mjs status`, show both, and stop
- `reset`: ask the user to confirm first, then run `phase.sh reset`
- `art`: run only the art step below, then stop. `art <id>` (for example `art K03` or `art c04`) works on that one asset.

Helper (run from the project root, exactly as written):
`${CLAUDE_SKILL_DIR}/scripts/phase.sh <next | resolve X | begin NAME | check | finish NAME | status | reset>`

## The art step

Every prompt is in `art/prompts.json` (one source for all of them); `node tools/art.mjs` reads it. Assets live in `art/source/{refs,keyframes,clips,overlays,audio}/` under the file names `node tools/art.mjs status` prints. Real art is optional for the build: phase 1 draws placeholders, and phase 2 imports whatever is present.

1. Run `node tools/art.mjs status`. It lists every asset in the order to make them (references A0 to A2, keyframes K01 to K12, clips c01 to c10, overlays, sound) with a ✓ or ·, and names the next missing one. Show the user the counts, not the whole table.
2. If everything required is present, say so and continue. If not, say in one line what is missing, then offer the three routes and ask which they want (AskUserQuestion, or plain text when unattended; unattended runs take route C and say so):
   - **A. You make them here.** Needs a connected tool that generates images (and takes reference images) or video. Use only a tool this session really has; look at the tool list, do not assume.
   - **B. They make them by hand with their own subscriptions.** Run `node tools/art.mjs sheet`: it writes `art/PROMPT-SHEET.md` with every prompt expanded, in order, with the files to attach and the path to save each one under. Tell them to work down it, and that `node tools/art.mjs prompt K03 --copy` copies one prompt to the clipboard.
   - **C. Skip the art for now.** The build continues on placeholders; run `/build-homeward art` whenever the art is ready, and phase 2's import picks it up.
3. Route A, images (references and keyframes, in order):
   - Each call spends the user's credits. Before the first one, say which tool and model you will use, how many frames are missing, and ask how many variants per frame (the plan suggests 4, one is cheapest) and for a yes.
   - For each missing frame, run `node tools/art.mjs prompt <id>`. It prints the expanded prompt and the files to attach (the man A0, the house A1 and A2, the previous keyframe). Attach exactly those; if the tool cannot take reference images, say so and fall back to route B for the frames that need them (K01 onward all do).
   - Save the result as `art/source/<kind>/<id>.png` using the path the command printed. Look at each result before the next frame: the pair checks are in `docs/IMAGE-PROMPTS.md` (eye colour, pupil centred in K04, house centred in K05 and K06, horizon and sun matching in K09 and K10, light from the left). With several variants, keep the best and say which and why in one line. Never generate a frame that already exists. If a frame fails its check twice, stop and show the user.
4. Route A, clips: use `tools/art-video.mjs` (Veo through the Gemini API). It chains each clip from the real last frame of the one before it.
   - Needs the keyframes, a `GEMINI_API_KEY` in the environment or in `.env.art`, and ffmpeg. If there is no key, tell the user to copy `.env.art.example` to `.env.art` and add their key themselves; never ask for the key in chat, never read `.env.art`, never print it.
   - Always dry-run first: `node tools/art-video.mjs`. Show the clips it would make and the estimate, ask how many takes per clip (the plan suggests 3 for c01, c02, c06 and c08, and 1 elsewhere), and ask for a yes. Skip c03-portal unless the user wants it.
   - On a yes, make ONE clip first: `node tools/art-video.mjs --only c01 --yes` (add `--takes 3` for several). Report the result in one line. If it fails, show the error and stop; never retry in a loop. If it works, ask once whether to continue with the rest, then run `node tools/art-video.mjs --yes`.
   - With several takes it stops after each clip. Run `node tools/art-video.mjs --sheet <clip>`, Read the contact sheet image, and judge the takes against the clip's row in `docs/CHECKS.md` (same face and clothes, steady speed, pupil centred, house centred, nothing odd). Tell the user which take you would pick and why; they choose. Then `node tools/art-video.mjs --pick <clip> <n>` and go on to the next clip.
   - A clip that exists is never made again unless the user says `--force`. If c08 will not slide the paper away, use plan B: `node tools/art-video.mjs --only c08 --plan-b c08 --yes`.
5. Overlays (dust.mp4, mist.mp4, paper.webp), sound (c01 to c10 and the bed) and the mark are not made by `art-video.mjs`. Route A only if a connected tool makes that kind of file; otherwise they stay on the sheet for the user and the site skips them silently.
6. End the art step with `node tools/art.mjs status` and say what is still missing.

## Only mode (`only <phase>`)

Runs exactly one named phase and touches no other phase's progress. Use it to build a phase out of order or to re-run a finished one.

1. Run `phase.sh resolve <phase>` with the text after `only`. It prints `PHASE n/total NAME FILE MODEL EFFORT`, then `STATE pending` or `STATE done (it will be re-run over the existing code)`, then, when earlier phases are unfinished, `NOTE earlier phases not done: ...`.
   - If it exits with `NO SUCH PHASE` or `AMBIGUOUS`, show its list and ask the user which phase they mean. Do not guess.
   - With no `<phase>` given, ask which phase, showing `phase.sh status`.
2. Tell the user in one line what will run: the phase, its model and effort, and whether it is new or a re-run. If a NOTE lists earlier unfinished phases, say so in the same line (later phases build on earlier ones, so this one may rely on code that is not there yet); the user asked for this phase by name, so continue without asking.
3. Do steps 3 to 7 of "For each phase" below for that NAME, using the model and effort `resolve` printed. If STATE is `done`, or the begin banner says it is re-running a finished phase, add to the subagent's prompt: `This phase was built before and its code is in the repo. Compare the repo with the prompt and change only what differs; do not duplicate or rewrite parts that already match.`
4. Stop after `phase.sh finish`. Do not go on to another phase. Say which phase `phase.sh next` would run now, and end with the latest `phase.sh status`.
5. If the phase fails or is stopped, report it as in "For each phase" step 6 and stop. A re-run that fails leaves the phase unfinished (begin re-opens it), so the next `/build-homeward` run picks it up again.

## For each phase

1. Run `phase.sh next`. It prints `PHASE n/total NAME FILE MODEL EFFORT` (MODEL is `fable`, `opus` or `sonnet`, EFFORT is `low`, `medium`, `high`, `xhigh` or `max`, both from `prompts/models.conf`), or `ALL DONE`. On `ALL DONE`, run `phase.sh status`, show it, and finish.
2. If NAME starts with `02-` and this run has not done the art step yet, do it first (a quick status and the three routes; the user may well say skip). The import in phase 2 is the first thing that reads `art/source/`.
3. Run `phase.sh begin NAME` and show its banner. Keep a visible task list with one item per phase; mark this one in progress. (`begin` on a finished phase re-opens it; only `only` mode does that.)
4. Delegate the phase with the Agent tool:
   - `subagent_type`: `homeward-phase-fable` when MODEL is `fable`, `homeward-phase-opus` when MODEL is `opus`, `homeward-phase-sonnet` when MODEL is `sonnet`. Never build the phase yourself, and never swap the model. If `homeward-phase-fable` is rejected because Fable is not available on this account, stop and tell the user, who can change that phase's line in `prompts/models.conf` to `opus max`.
   - `effort`: EFFORT exactly as printed. If the call is rejected because that level is not available for the model, retry once with `high` and tell the user which phase fell back.
   - prompt: `Build phase NAME. Prompt file: FILE.` Add `This phase is resuming; check what already exists.` if the begin banner said so (for a re-run of a finished phase, use the wording given in "Only mode").
   - Wait for the result.
5. Read the subagent's reply. If it starts with `RESULT: FAILED`, or it mentions `STOP`, do not finish: show the user its report and stop.
6. Run `phase.sh finish NAME`. It refuses unless the check passed, then commits using `prompts/NAME.commit` (title and description), pushes, marks the phase done, and prints progress. Show the subagent's 3 to 6 line summary plus the commit and push lines. Mark the task completed.
   - If finish prints `REFUSED`, send the same subagent type the task again with `The build check has not passed yet; fix it and run phase.sh check.` One retry only, then stop and report.
   - If it prints `PUSH FAILED` or `STOP`, stop and show the error.
7. With no argument, go back to step 1. With `next`, stop and say which phase, model and effort come next.

## Rules

- Outside `only` mode, phases are strictly sequential; `phase.sh next` decides the order and the model. In `only` mode the user names the phase and `phase.sh resolve` gives its model and effort; never change either.
- A phase is done only after `phase.sh finish` succeeds. `finish` commits the site code; the prompts, the skill, `tools/` and `art/prompts.json` are left out of phase commits and are committed by hand.
- Never spend credits or API money without an explicit yes from the user in this run, and never ask for or print a key.
- A generated asset is never overwritten. Frames and clips the user made themselves are theirs: use them as they are.
- Do not invent results. Report what the commands and subagents actually returned.
- If the subagents are missing (`homeward-phase-fable` / `-opus` / `-sonnet` not found), stop and tell the user they live in `.claude/agents/` and Claude Code must be started in the project root.
- If a prompt changed in `art/prompts.json`, run `node tools/art.mjs docs` to refresh `docs/IMAGE-PROMPTS.md`, `docs/VIDEO-PROMPTS.md` and `docs/EXTRA-ASSETS.md`. If `prompts/_shared-rules.md` changed, run `node tools/shared-rules.mjs`.
- End every run with the latest `phase.sh status` output (and, after an art step, `node tools/art.mjs status`).
