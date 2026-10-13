import { expect, test } from "@playwright/test";
import { chapters } from "../src/content/story";
import { expectPicture, holdAt, openFilm, settle, shot, steps, timeline } from "./stage";

/**
 * Scrubbing replays exactly. For every chapter the film is held at 41 positions across it (40 steps,
 * the join windows at both ends included), first forward and then back, at a fixed ambient clock, and
 * the canvas must read back the same at each position both ways. No step may show a blank or
 * see-through canvas.
 */
const STEPS = 40;

for (const chapter of chapters) {
  test(`${chapter.id}: ${STEPS} steps forward and ${STEPS} back draw the same frames, none blank`, async ({ page }) => {
    await openFilm(page);
    const placed = (await timeline(page)).chapters.find((c) => c.id === chapter.id);
    test.skip(!placed, `${chapter.id} is left out of this story (an optional clip without frames)`);
    if (!placed) return;

    const positions = steps(placed.startP, placed.endP, STEPS);
    const forward: string[] = [];
    for (const [k, p] of positions.entries()) {
      await holdAt(page, p);
      await settle(page);
      const s = await shot(page);
      expectPicture(s, `${chapter.id} step ${k} forward (p ${p.toFixed(5)})`);
      forward.push(s.hash);
    }

    const back: string[] = [];
    for (const [k, p] of [...positions.entries()].reverse()) {
      await holdAt(page, p);
      await settle(page);
      const s = await shot(page);
      expectPicture(s, `${chapter.id} step ${k} back (p ${p.toFixed(5)})`);
      back[k] = s.hash;
    }

    for (const k of positions.keys()) {
      expect(back[k], `${chapter.id} step ${k} (p ${positions[k].toFixed(5)}) is the same frame both ways`).toBe(forward[k]);
    }
    // The scrub really moved through different pictures.
    expect(new Set(forward).size, `${chapter.id}: the steps show different frames`).toBeGreaterThan(STEPS / 2);
  });
}
