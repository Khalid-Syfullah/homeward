# Homeward: performance

The budget lives in `tune.budget` in `src/content/story.ts`, and `npm run perf` (`scripts/perf.mjs`) checks it against the production build. Every number below was measured that way on placeholder frames, because no real art exists yet. Real art is larger, so each payload line also gives a projection at the frame sizes `docs/EXPORT.md` expects (90 KB at 1440 px, 35 KB at 768 px). Run `npm run build && npm run perf` again after `npm run art:import`.

## The budget

| Budget | Target | Measured on placeholders | With real art (projected) |
| --- | --- | --- | --- |
| First-paint payload (the loading frame and the first 24 frames) | under 1.5 MB | desktop 0.18 MB (25 frames), phone 0.16 MB (24 frames); 0.49 and 0.46 MB with the page itself | desktop 0.93 MB of frames, 1.23 MB with the page; phone 0.84 and 1.14 MB |
| First frame on screen, Fast 4G | under 1.5 s | the loading frame at 488 to 620 ms; the canvas at 794 to 895 ms | the desktop loading frame grows from 27 KB to about 90 KB, about 0.1 s more |
| Scrubbing | 60 fps on a mid laptop | 60.0 fps with no frame over 1.5 vsyncs, desktop and phone, also with the CPU 4x slower | frames upload at the same pixel size, so the GPU work does not change |
| Memory | under the caps | decoded frames 159.5 of 160 MiB; encoded 14.9 (desktop) and 3.7 MiB (phone) of 48 MiB | the decoded cap holds; encoded grows with the files, within its cap |

Every budget line passed in every run, with one exception, explained under the scrubbing numbers: the frame-rate line cannot be judged while the browser is saving power.

## What was over, and the fix

The commit before this phase (`e4325cd`), measured the same way:

| | Before (desktop) | After (desktop) | Before (phone) | After (phone) |
| --- | --- | --- | --- | --- |
| First film frame on screen | canvas at 1507 to 1539 ms | loading frame at 508 to 620 ms, canvas at 794 to 884 ms | canvas at 1285 to 1295 ms | loading frame at 488 to 500 ms, canvas at 863 to 895 ms |
| First 24 frames | 24 at 1440 px, all in at 2.5 s | 24 at 768 px plus the opening frame at 1440 px, all in by 1.8 s | 24 at 768 px, all in at 2.1 s | 24 at 768 px, all in by 1.7 s |
| Frame bytes in that set (placeholders) | 667 KB | 184 KB | 156 KB | 156 KB |
| The same with real art | 24 x 90 KB = 2.16 MB, about 2.6 MB with the page and the hidden poster | 0.93 MB, 1.23 MB with the page | 0.84 MB, about 1.23 MB with the page and the hidden poster | 0.84 MB, 1.14 MB with the page |

Before, the desktop missed the first-frame budget even on small placeholders, and with real art its first-paint payload would have been well over 1.5 MB. These changes fixed both:

1. **The loading frame.** The server-rendered HTML now carries the film's opening frame as a plain `<picture>` with `fetchpriority="high"`: the 1440 px frame on desktop, the 768 px one on phones (`src/stage/Stage.tsx`). It is placed by the canvas's own cover fit, written in CSS with container units and the focal-point clamp, under the same vignette the first chapter starts with (`vignetteGradient` in `looks.ts`). The browser paints it before any script runs. The frame store then asks for the same URL and gets it from the HTTP cache, so the canvas takes over without a visible change. `tests/loading.spec.ts` compares the two pictures: the mean difference is 0.3 levels, with no value more than 32 levels off, even on a 21:9 screen where the vignette reaches into the corners.
2. **The first-paint set.** Until it is in, the frame store loads only the 24 frames nearest the playhead at the 768 tier, led by the frame on screen at the tier the device plays (`tune.firstPaint`, `frameStore.ts`), all at high fetch priority. After that it loads at the playing tier as before. Until their own tier arrives, the narrow frames stand in, still blended in pairs.
3. **Inlined manifests.** The page carries every clip's manifest (`src/content/frames.server.ts`), so the first frame request does not wait a round trip for them. In production they are read again from the network once the first paint is in; in development, straight away.
4. **The no-script poster is lazy.** K05 (`site.poster`) is shown only with scripts off. React used to preload it and every visitor downloaded it; now it is never requested with scripts on, and with scripts off browsers load it straight away.
5. A frame index with nothing to blend needs only its own frame, so the opening picture is one file.

## How it was measured

- `npm run build`, then `npm run perf`, which starts `next start` on a free port, or `npm run perf -- --url <server>`. `--json <file>` writes every number; `--speed <vh/s>` changes the scrub speed.
- Browser: Playwright 1.64's Chromium 156 in new headless mode, which renders WebGL on the machine's GPU (here ANGLE over Metal on an Apple M2 Pro, 16 GB, macOS 15.5). Each first-paint run uses a fresh context, so the cache starts cold.
- **Fast 4G** is Chrome DevTools' preset: 9 Mbps down and 1.5 Mbps up at 90 percent, and 60 ms of latency times 2.75. That is 1,012,500 and 168,750 bytes per second, with 165 ms added to every request.
- **First paint** runs desktop at 1440x900 @2x, and a phone at 390x844 @3x with touch and the CPU slowed 4x. It records the loading frame's Element Timing entry (a full-screen image is not a largest-contentful-paint candidate), the user timing marks `homeward:first-frame` (the canvas's first draw) and `homeward:first-paint` (the first-paint set is in), and the bytes from Resource Timing. A frame fetched twice is counted once: the loading frame, then the store's fetch of it from the cache.
- **Scrub** drives `window.scrollTo` once per animation frame at a steady 60 vh/s, from the top of the page to the bottom (about 17.5 s), with frames from the local server. It runs on desktop 1440x900 @2x, then with the CPU 4x slower, then on the phone at 390x844 @3x with the CPU 4x slower. It records the frame intervals, the stage's own step time (`stats().render`), how often a stand-in frame was on screen, and the memory peaks (`stats()`, plus the JS heap through the DevTools protocol). First, the same driver scrolls a trivial page, to find out how fast the browser itself paces scrolling.
- First paint and memory: five runs on the final build. Scrubbing: the runs taken while the browser paced scrolling at 60 Hz (see below).

## Detailed numbers

**First paint, Fast 4G, five runs**

| | Desktop 1440x900 @2x | Phone 390x844 @3x, CPU 4x slower |
| --- | --- | --- |
| Tier, canvas | 1440, 2520x1575 | 768, 585x1266 (pixel ratio capped at 1.5) |
| Loading frame painted | 508 to 620 ms | 488 to 500 ms |
| Canvas first frame | 794 to 884 ms | 863 to 895 ms |
| First-paint set in | 1694 to 1774 ms | 1625 to 1685 ms |
| Frames in the set | 25 (24 at 768, 1 at 1440): 184 KB | 24 at 768: 156 KB |
| Everything by then | 0.49 MB: scripts 165 KB, fonts 126 KB, styles 6 KB, document 6 KB, manifests 1 KB | 0.46 MB |

The first-paint set takes about 1.7 s because `next start` serves HTTP/1.1. Chrome opens six connections per host, so the 24 requests go out in four rounds, each paying the 165 ms latency. A host that speaks HTTP/2 sends them all at once.

**Scrubbing, 60 vh/s through the whole film**

These seven runs come from two builds whose per-frame path is the same: six on the build before the last fixes (which changed only startup and the overlay-failure wake-up), one on the final build.

| | Desktop @2x | Desktop @2x, CPU 4x slower | Phone @3x, CPU 4x slower |
| --- | --- | --- | --- |
| Runs | 7 | 7 | 4 |
| Frame rate | 60.0 fps | 60.0 fps | 59.1 to 60.0 fps |
| Frame interval: median, 95th, 99th percentile | 16.7, 16.7 to 16.8, 16.8 ms | 16.7, 16.7 to 16.8, 16.8 ms | 16.7, 16.7 to 16.8, 16.8 ms |
| Frames over 1.5 vsyncs | 0 | 0 | 0, in one run 1 (a single 283 ms frame) |
| Stage step: mean, longest | 0.68 to 1.18 ms, 2.8 to 4.6 ms | 2.60 to 2.94 ms, 10.4 to 13.7 ms | 1.21 to 1.48 ms, 8.3 to 9.9 ms |
| Stand-in frames on screen | 0 percent | 0 percent | 0 percent |
| Blank frames | 0 | 0 | 0 |

A faster flick at 200 vh/s (about 5 s for the whole film) also held 60 fps with no stand-ins. The stage step averaged 2.1 ms, or 7.8 ms with the CPU 4x slower. The single 283 ms frame came in one phone run out of four and did not recur, even with long-animation-frame attribution recording; the stage's own step never took longer than 8.3 ms in that run.

**Power saving.** Later runs on the final build, with the laptop on battery below 20 percent, paced every scroll at 30 Hz. Even a trivial page, a single gradient scrolled once per frame, ran at 30 Hz at normal CPU speed. That was not the site's work. A DevTools trace of the phone scrub then showed the renderer's main thread busy only 38 percent of the time and the GPU process 6 percent: nothing was full, the frames were simply paced. `npm run perf` now times that trivial page first. When the browser paces it below the target, the script reports the frame-rate line as SKIP instead of judging it. Memory, blank frames and stand-ins are still checked: zero blank frames and zero stand-ins in all five runs on the final build.

**Memory, peaks during the scrub (five runs on the final build)**

| | Desktop @2x (1440 tier) | Phone @3x (768 tier) | Cap |
| --- | --- | --- | --- |
| Decoded frames (ImageBitmaps) | 159.5 MiB, 38 to 53 frames | 159.5 MiB, 126 frames | 160 MiB (`tune.memoryCapMb`) |
| Encoded frames (WebP bytes) | 14.9 MiB | 3.7 MiB | 48 MiB (`tune.blobCapMb`) |
| GPU textures | 35.6 MiB (8 frames) | 10.1 MiB | 8 textures (`tune.textureCache`) |
| JavaScript heap | 7.9 to 8.3 MiB | 7.7 to 8.2 MiB | |

The decoded peak sits just under the cap on purpose: the store keeps the frames nearest the playhead until the cap is full and never goes past it.

## Phones

- Every chapter has its own focal point in `story.ts` (the man's face for c01, the pupil for c02, the house for c03 and c04, the sea photograph for c07 and c08, the waterline for c09). The pupil and the photograph are named constants, shared by the anchors and the focal points. At 390x844 a portrait phone shows 26 percent of the frame's width, and at 360x640 it shows 32 percent; the cover fit keeps the focal point in the middle.
- Phones play the 768 tier, with the canvas's pixel ratio capped at 1.5: 585x1266 on a 390x844 @3x screen. A phone is a viewport up to 768 px wide, or up to 500 px tall (a phone held sideways).
- Captions sit in the lower third and the rail is a thin bar. Its chapter buttons stay in the accessibility tree and the tab order, and the rail opens out again while one of them has keyboard focus.

## The tests

`npm test` builds the site, starts it, and runs Playwright (`playwright.config.ts`, `tests/`). The `chromium` project runs every spec on the headless shell's software WebGL, so it gives the same pixels on any machine. The `chromium-gpu` project runs the pixel-exact specs again on the machine's GPU. `HOMEWARD_WEBKIT=1 npm test` adds Playwright's WebKit, which needs `npx playwright install webkit`.

| Spec | What it checks |
| --- | --- |
| `scrub.spec.ts` | For every chapter: 40 steps forward and 40 back at a fixed clock (`?clock=1500`), the same canvas hash at every step both ways, and no blank or see-through frame |
| `joins.spec.ts` | Every join drawn at t = 0 and t = 1 differs from the plain frame at the edge of its window by exactly 0 (largest channel difference 0), at rest and at full speed; halfway through it differs from both |
| `anchors.spec.ts` | At 1920x1080, 1366x768, 768x1024, 390x844 and 360x640, the pupil and the photograph sit inside the viewport (at least 10 percent from every edge) where their joins start, and on placeholder frames the canvas shows them there; so does every focal point |
| `phones.spec.ts` | 390x844, 360x640 and 844x390 at 3x: the 768 tier, a canvas at pixel ratio 1.5, captions in the lower third and on screen, the rail as a thin bar no touch can hit, no sideways overflow; desktop 1440x900 at 2x keeps the 1440 tier and the full rail |
| `reduced-motion.spec.ts` | With reduced motion: the clock equals the scroll, every join is a cross-dissolve exact at both ends, no overlays, the loop rests, real scrolling forward and back gives the same frames, keyboard jumps land at once, captions do not rise |
| `keyboard.spec.ts` | The arrow keys, Page Up and Page Down step through every chapter and back, and Home and End reach the ends; the live region names each chapter; the tab order runs skip link, wordmark, ten chapters, sound; the skip link lands on the end panel; a chapter button jumps to its chapter |
| `loading.spec.ts` | At 1440x900, 2560x1080 and 390x844 the canvas takes over from the loading frame without a visible change, in the whole picture and in its corners |

On the final build all 125 tests passed: 53 in `chromium`, 19 in `chromium-gpu` and 53 in WebKit 27.2. Making two deliberate mistakes confirmed the specs catch them: a push join that starts 2 percent in, and a random blend in the frame pick. The join and scrub specs both failed.

The WebKit runs also turned up a real bug. A missing overlay file (no art yet) failed after the render loop had come to rest, and nothing woke the loop, so the stage never learned the overlay was gone. That cost nothing on screen, since there was no overlay either way, but the held picture never counted as settled. The overlays now wake the stage when they fail. After the fix, the WebKit suite passed 53 of 53 in nine runs in a row.

## What could not be verified

- **A real phone GPU.** Every phone number above comes from Chromium's phone emulation on an M2 Pro: the viewport, the pixel ratio, touch, and the CPU slowed 4x. The GPU is not slowed, and a phone GPU's texture upload and fill rate were not measured.
- **iOS Safari.** WebKit 27.2 on macOS passes every spec, but that is not iOS Safari. Untested: its per-tab memory limit against 160 MiB of decoded frames, the address bar resizing the viewport against the `100lvh` stage, momentum scrolling, and the 30 fps animation frames of Low Power Mode.
- **Hand-driven trackpad scrolling.** Every scrub was driven by script (`scrollTo` once per frame at 60 and 200 vh/s) or by the keyboard. Real trackpad and wheel events, with their momentum and uneven deltas, were not tested.
- **A mid laptop.** Measured on an Apple M2 Pro; the CPU slowed 4x stands in for a slower machine, but the GPU was not slowed.
- **Real art.** All measurements use placeholder frames, which are smaller than real ones; the projections use the sizes in `docs/EXPORT.md`. Real frames decode at the same pixel size, so decode, upload and memory should match; bytes and load times will be higher.
- **A real host.** `next start` on localhost over HTTP/1.1, with Fast 4G emulated. A real host adds DNS and TLS, and probably speaks HTTP/2.
- **Overlays and sound.** None of their files exist yet, so the cost of decoding the mist and dust videos and of the sound engine was not measured. Playwright's Chromium cannot play H.264 at all.
