<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 6 of 8: Chapters 5 to 10: house, book, pages, sea, shore, sky
(1) c05 to c07: a dust overlay (dust.mp4, screen blend, opacity 0.25, only inside the house chapters, eased in and out over the joins). (2) c06 to c08: the paper texture (paper.webp, tiled, soft-light at 12 percent) over the book chapters, fading to zero across the join into the real sea. (3) c07: frame advance follows scroll with a little extra smoothing and a cap of 3 displayed frames per render, so a fast flick does not strobe the page flips. (4) c08 and c09: nothing added; the rect join does the work if c08 stayed inside the book. (5) c10 and the end screen: after the last frame the stage holds on pure sky and a calm panel (ink on paper at 92 percent, in the caption column) appears with the closing line, a Replay button that smooth-scrolls to the top (instant under reduced motion), and one link slot kept as a placeholder constant in story.ts. Captions work as in phase 5.
Done when: chapters 5 to 10 and the end screen scrub forward and back without pops, and Replay returns to the first frame.

REPO NOTES
- Read first: docs/COPY.md, docs/EXTRA-ASSETS.md, src/content/story.ts, src/stage/, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
