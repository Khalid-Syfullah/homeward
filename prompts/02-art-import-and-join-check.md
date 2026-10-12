<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 2 of 8: Art import and join check
Write scripts/art-import.mjs (Node, with ffmpeg and ffprobe through child_process; if they are missing, stop with a clear install message). For every art/source/clips/<clip>.mp4: normalise to 24 fps 1920x1080 near-lossless without audio into art/work/; write the number of frames set in story.ts, evenly spaced and including the first and last frame, as WebP into public/frames/<clip>/1440/f_###.webp (quality 78, 1440 wide) and /768/ (quality 72, 768 wide); write manifest.json ({clip, tiers: {1440: {count}, 768: {count}}}), poster.webp, and art/work/<clip>.first.png and .last.png. Fingerprint every input and the script itself so unchanged clips are skipped; support --force and --only <clip>. Enforce a size budget (env ART_BUDGET_MB, default 60 for the 1440 tier; ART_BUDGET_768_MB, default 22) first by lowering quality, then by dropping every n-th frame, and print what it did. A clip with no source falls back to its placeholder frames, never an error.
Write npm run art:check: for each join in story.ts compare the last frame of a clip with the first frame of the next, both downscaled to 64x36, and report the mean absolute difference over the whole frame and over the centre third as OK, WARN or FAIL against thresholds at the top of the script (start with 0.04 and 0.08). Also report whether the pupil anchor sits on a dark region of c02's last frame, and whether c08's last frame has a lighter border around the photoRect anchor. Print a table, suggest in one line which join type fits a mismatched pair, and exit non-zero only on FAIL.
Done when: with three sample clips in art/source/clips, art:import and then art:check print a table, public/frames is populated, and the site shows the real frames.

REPO NOTES
- Read first: docs/EXPORT.md, docs/PLAN.md, docs/ARCHITECTURE.md, src/content/story.ts, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
- Only art/source/clips/<clip>.mp4 files are inputs. Ignore *.take<N>.mp4, *.last.png, *.sheet.png and *.json in that folder: tools/art-video.mjs writes them.
- Clip ids and the art/source/ layout are defined in art/prompts.json and docs/EXPORT.md. Do not edit art/prompts.json or tools/.
- Site scripts go in scripts/; add art:import and art:check to package.json.
