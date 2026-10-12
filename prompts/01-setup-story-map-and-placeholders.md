<!-- shared-rules:start (edit prompts/_shared-rules.md, then run: node tools/shared-rules.mjs) -->
SHARED RULES (prepend to every phase)
- Stack: Next.js App Router, TypeScript (strict), CSS modules. No animation, scroll or 3D libraries (no GSAP, Lenis, Three.js, Framer Motion). The stage is raw WebGL 1 on one fixed full-viewport canvas; all text is real DOM.
- Scroll position is the clock. Every visual and audio state is a pure function of the smoothed progress p (0 to 1), so scrubbing back replays exactly. Nothing plays on a timer except ambient breathing, and that is off under reduced motion.
- All content lives in src/content/story.ts: chapters, clips, scroll lengths, frame counts, joins, anchors, focal points, captions, ambience. No magic numbers in shaders or components; tunable values sit in a tune object the dev HUD can show.
- The site must run end to end on generated placeholders before any real art exists, and must pick up real frames from public/frames/<clip>/ the moment they appear.
- Never draw a blank frame. Never let a transition pop on or off: every term is exactly zero outside its window.
- Keep lint, typecheck and build green. Do not commit or push unless the phase says so. Finish with 3 to 6 lines: what changed and what you could not verify.
<!-- shared-rules:end -->

PHASE 1 of 8: Setup, story map and placeholders
Create the Next.js project. Add src/content/story.ts with the ten chapters below and these helpers: cumulative scroll ranges in vh, chapterAt(p), localT(p), joinWindow(chapter). Each chapter has: id, title, clip, scrollVh, frames (the same for both tiers), join into the next chapter ('push' | 'portal' | 'rect' | 'none'), anchors (pupil {x,y} for c02, photoRect {x,y,w,h} for c08, all in 0..1 frame coordinates), a focal point for desktop and for phone ({x,y} in 0..1, default 0.5 and 0.5), a caption {title, line}, and an ambience id.

id             scrollVh  frames  join
c01-follow     100       60      push
c02-eye         70       42      portal
c03-portal      80       48      push    (optional clip: if its frames are missing the chapter is skipped and c02 joins c04 with 'portal')
c04-descent    130       78      push
c05-enter      100       60      push
c06-book        80       48      push
c07-pages      110       66      push
c08-sea-alive  100       60      rect    (use 'push' if c08 ends on the full-frame sea; art:check in phase 2 tells you)
c09-shore      100       60      push
c10-sky         80       48      none

Default anchors: pupil {0.5, 0.5}; photoRect {0.2, 0.2, 0.6, 0.45}.
Design tokens: valley green #2F5D3A, moss #6B8E4E, teak #7A4B2A, terracotta #B5573A, brass #C9A24B, paper #EFE3C8, sky #8FB8D8, ink #1E1B16; a display serif with italics for captions and a plain sans for the rail, both through next/font.
Page shell: a tall scroll container whose height is the sum of scrollVh plus one end screen of 100vh, holding one sticky full-viewport stage element.
Placeholders: scripts/placeholders.mjs writes, for every clip, the chapter's frame count of painterly gradient frames in the palette with the chapter number and title set large (WebP, tiers 1440 and 768) plus manifest.json under public/frames/<clip>/, so every later phase works with no art.
Done when: npm run dev shows the stage, scrolling cycles through the placeholder chapters, and npm run build is green.

REPO NOTES
- Read first: docs/PLAN.md, docs/STYLE-BIBLE.md, docs/COPY.md, docs/ARCHITECTURE.md, and the code from earlier phases. Do not edit tools/, prompts/ or art/prompts.json.
- This repository already contains tools/, art/, docs/, prompts/, .claude/, README.md and .gitignore. Never delete, overwrite or scaffold over them: write the Next.js files by hand, or scaffold into a temporary folder and copy only the app files across (package.json, tsconfig.json, next.config.*, the ESLint config, src/, public/).
- Site scripts go in scripts/ (placeholders.mjs now, art-import.mjs in phase 2). tools/ belongs to the asset pipeline and the build skill: do not edit it.
- Captions in story.ts come from docs/COPY.md; the palette is in docs/STYLE-BIBLE.md; the folder layout under art/source/ is in docs/EXPORT.md.
- package.json scripts: dev, build, start, lint, typecheck (tsc --noEmit) and placeholders. The build check runs lint, typecheck and build in that order, so all three must exist and pass.
- public/frames/ and public/audio/ are generated and git-ignored: do not commit them.
