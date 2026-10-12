<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 7 of 8: Chrome, captions, sound, accessibility
Chrome: the wordmark top left (a link to the top), a sound toggle top right (off by default, never autoplays), a vertical progress rail on the left with one tick per chapter (the current one highlighted, its name on hover and focus, a click scrolls smoothly to the chapter start), and a thin progress line. Keyboard: arrow keys and PageUp and PageDown move chapter by chapter, Home and End go to the ends, focus is always visible, tab order follows the page. Sound: a WebAudio engine with one ambience loop per chapter (art/source/audio/*.m4a with an .ogg fallback, copied to public/audio), a 1.2 s crossfade on chapter change driven by chapterAt(p), a music bed under everything, master gain ramped on toggle, started only after a user gesture, paused when the tab is hidden, default volume 0.6; a missing file is skipped silently. Accessibility: the canvas is role=img with an aria-label that follows the current chapter title and caption; captions are real DOM text; a Skip to end link; reduced motion means no smoothing lag, plain cross-dissolve joins and no overlays; with JavaScript off the page shows the poster and the ten captions as a readable list. Wire the copy deck in docs/COPY.md into story.ts.
Done when: keyboard-only navigation works end to end, sound crossfades per chapter, and the no-JavaScript view reads well.

REPO NOTES
- Read first: docs/COPY.md, docs/EXTRA-ASSETS.md, src/content/story.ts, src/stage/, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
- The copy deck is docs/COPY.md; wire it into story.ts. The sound files are described in docs/EXTRA-ASSETS.md; art/source/audio/ holds c01.m4a to c10.m4a and bed.m4a (a missing file is skipped silently).
