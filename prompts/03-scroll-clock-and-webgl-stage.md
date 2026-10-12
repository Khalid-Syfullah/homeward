<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 3 of 8: Scroll clock and the WebGL stage
Build the engine in src/stage. (1) A smoothed scroll clock: a critically damped spring on window scroll, frame-rate independent, snapping when reduced motion is set; it exposes p in 0..1 and a velocity. (2) A frame store: decoded ImageBitmaps for the active chapter plus a lookahead of two chapters, loaded nearest-first, stale loads cancelled, a memory cap (default 160 MB) with least-recently-used eviction, the 768 tier on phones, slow connections or when memory is tight. (3) A WebGL 1 compositor that draws the floor and ceil frames of the fractional frame index and blends them by the fraction, cover-fitted with the chapter's focal point (so phones crop around the subject), at a device pixel ratio capped at 1.75. (4) A dev HUD (?hud=1) showing p, chapter, local t, frame index and cache size, and ?p=0.42 to freeze progress. If the wanted frame is not loaded yet, draw the nearest loaded one; never draw blank.
Done when: scrubbing forward and back with real or placeholder frames never shows a blank or flashing frame, and the HUD agrees with the story map.

REPO NOTES
- Read first: docs/ARCHITECTURE.md, docs/PLAN.md, src/content/story.ts, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
