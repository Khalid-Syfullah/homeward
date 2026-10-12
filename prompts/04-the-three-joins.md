<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 4 of 8: The three joins
Add short transitions to the compositor, each a pure function of join time t in 0..1 over a window of 12 frames across a chapter boundary. (a) push: a cross-dissolve with a zoom push (outgoing 1.00 to 1.06, incoming 1.06 to 1.00) and a 5-tap radial smear that scales with scroll velocity. (b) portal: a circular reveal centred on the pupil anchor, converted with the same cover-fit math as the frames so it holds at any viewport; its radius grows from 0 to the screen diagonal with a noise-bitten, feathered edge, the incoming frame scaling from 1.25 to 1.00 inside the circle, and a faint dark ring at the rim. (c) rect: the photoRect anchor grows from its on-screen position and size to fill the viewport with a soft edge, the paper border sliding off, the incoming frame matched in scale at t=0.
Rules: every term is exactly zero outside the window; smear and edge amplitudes scale with the absolute velocity; pixels provably outside the effect take a single-tap fast path; reduced motion replaces all three with a plain cross-dissolve. Add ?join=<chapter id>&t=<0..1> to hold any join, and an anchor picker in the HUD (click a frame to print normalised coordinates).
Done when: each join scrubs smoothly forward and back, and at t=0 and t=1 the output differs from the neighbouring frames by exactly 0.

REPO NOTES
- Read first: docs/ARCHITECTURE.md, docs/PLAN.md, src/content/story.ts, src/stage/, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
