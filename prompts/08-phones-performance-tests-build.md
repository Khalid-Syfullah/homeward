<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 8 of 8: Phones, performance, tests, production build
Phones: per-chapter focal points in story.ts so the subject stays in view at 390x844 and 360x640, the 768 tier, a device pixel ratio cap of 1.5, captions in the lower third, the rail reduced to a thin bar. Performance: measure and write docs/PERF.md: first-paint payload under 1.5 MB (poster plus the first 24 frames), first frame on screen in under 1.5 s on a fast-4G profile, 60 fps scrubbing on a mid laptop, memory under the cap; fix anything over. Tests (Playwright): for every chapter scrub 40 steps forward and 40 back at a fixed clock and assert identical canvas hashes; no blank or transparent frame in any step; each join's t=0 and t=1 differ from the neighbouring frames by exactly 0; anchors fall inside the viewport at five sizes; a reduced-motion run; keyboard navigation. Make a production build and report what you could not verify (a real phone GPU, iOS Safari, hand-driven trackpad scrolling).

REPO NOTES
- Read first: docs/CHECKS.md, docs/ARCHITECTURE.md, src/content/story.ts, src/stage/, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
