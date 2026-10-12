<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 5 of 8: Chapters 1 to 4: road, eye, valley, descent
Add per-chapter treatment on top of the engine, driven by story.ts and p. (1) c01: scale 1.00 to 1.03 and a 0 to -12 px vertical drift across the chapter, and a warm vignette that tightens as the face arrives. (2) c02: while the page rests, a slow breathing (scale 1.000 to 1.010 on a 6 s sine of the clock, amplitude falling to zero while scrolling fast) and a dark vignette that closes toward the pupil anchor. (3) c03 and c04: a mist overlay (art/source/overlays/mist.mp4 as a looping video texture, screen blend, opacity following the descent from 0.35 to 0); skip silently if the file is missing. (4) Captions: each chapter's title and one line fade in only after the picture has settled (camera speed under a threshold for 200 ms of scroll) and leave before the join window, in a caption column that avoids the subject's third (left on desktop, lower third on phones). Reduced motion: no breathing, no vignette motion, no overlay motion.
Done when: chapters 1 to 4 scrub smoothly forward and back, captions never overlap a join, and nothing moves at rest under reduced motion.

REPO NOTES
- Read first: docs/COPY.md, docs/EXTRA-ASSETS.md, src/content/story.ts, src/stage/, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
