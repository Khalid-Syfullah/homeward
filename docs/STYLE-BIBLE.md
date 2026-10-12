# Homeward: style bible

Paste STYLE before every image and video prompt, WALKER wherever the man appears, and REGION wherever a building or room appears. Every prompt uses the tokens {STYLE}, {WALKER} and {REGION} for these three blocks, plus NEGATIVE for the negative field.

The four blocks live in art/prompts.json under `blocks`: change them there (for example REGION, to your own place), then run `node tools/art.mjs docs`. `node tools/art.mjs blocks` prints them.

**Palette** (use it in prompts, in the site tokens, and as the check for a colour drift between clips)

| Name | Hex | Where it lives |
| --- | --- | --- |
| Valley green | #2F5D3A | fields, canopy, the book cover |
| Moss | #6B8E4E | grass in light, new leaves |
| Teak | #7A4B2A | doors, shelves, reading desk |
| Terracotta | #B5573A | roof tiles, pots |
| Brass | #C9A24B | lamps, the book's emblem, sun glints |
| Paper | #EFE3C8 | book pages, the site background |
| Sky | #8FB8D8 | sky, sea haze |
| Ink | #1E1B16 | text on paper and on the site |

**Camera rules** (they hold for every clip, because the page scrubs each one backwards too)

- One camera move per clip, slow and steady. No cuts, no whip pans, no handheld shake.
- The sun stays low and from the left for the whole film, so light never jumps between clips.
- The subject sits in the centre third at both ends of every clip. That makes joins invisible and phone crops safe.
- Ask for 24 fps and the longest length your tool offers; the scroll decides how fast it plays.

**Consistency kit.** Attach A0 (the man) to every frame he is in, A1 and A2 (the house) to every house frame, and the previous keyframe as a style reference to every new one.
