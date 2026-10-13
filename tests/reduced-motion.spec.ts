import { expect, test, type Page } from "@playwright/test";
import { diff, expectPicture, holdAt, holdJoin, openFilm, settle, shot, steps, timeline } from "./stage";

/**
 * A run with prefers-reduced-motion: reduce. The clock follows the scroll with no smoothing, every join
 * is a plain cross-dissolve (still exact at both ends), there are no overlays and no breath, so the render
 * loop rests as soon as the scroll does, keyboard jumps land at once and captions do not rise. Real
 * scrolling forward and back must draw the same frames. No ambient clock is held here: nothing should
 * move without the scroll.
 */
test.use({ reducedMotion: "reduce" });

/** Scroll the window to progress p (instantly) and return the scroll position used. */
async function scrollToP(page: Page, p: number): Promise<number> {
  return page.evaluate((p) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const y = Math.round(p * max);
    window.scrollTo({ top: y, behavior: "instant" });
    return y;
  }, p);
}

test("the clock follows the scroll exactly and the loop rests when the scroll does", async ({ page }) => {
  await openFilm(page, { clock: "" });
  const { chapters } = await timeline(page);
  const eye = chapters.find((c) => c.id === "c02-eye")!;
  const y = await scrollToP(page, (eye.startP + eye.endP) / 2);
  await settle(page);
  const state = await page.evaluate((y) => {
    const f = window.homewardStage!.frame!;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return { p: f.p, target: f.target, expected: y / max, reduced: f.reducedMotion, chapter: f.chapter.id, overlays: f.overlays.length };
  }, y);
  expect(state.reduced).toBe(true);
  expect(state.p).toBe(state.target);
  expect(state.p).toBeCloseTo(state.expected, 12);
  expect(state.chapter).toBe("c02-eye");
  expect(state.overlays).toBe(0);
  // The breath chapter, with the real clock running: under reduced motion nothing keeps the loop going.
  await expect.poll(() => page.evaluate(() => window.homewardStage!.running), { timeout: 5_000 }).toBe(false);
});

test("every join is a cross-dissolve, exact at both ends", async ({ page }) => {
  await openFilm(page, { clock: "" });
  const { joins } = await timeline(page);
  for (const w of joins) {
    await holdJoin(page, w.from, 0.5);
    await settle(page);
    expect(await page.evaluate(() => window.homewardStage!.frame!.join?.kind), `${w.from} > ${w.to}`).toBe("dissolve");
    await shot(page, "middle");

    await holdAt(page, w.startP);
    await settle(page);
    await shot(page, "before");
    await holdJoin(page, w.from, 0);
    await settle(page);
    await shot(page, "start");
    expect(await diff(page, "before", "start"), `${w.from} > ${w.to}: t = 0`).toEqual({ maxDiff: 0, differing: 0 });

    await holdAt(page, w.endP);
    await settle(page);
    await shot(page, "after");
    await holdJoin(page, w.from, 1);
    await settle(page);
    await shot(page, "end");
    expect(await diff(page, "after", "end"), `${w.from} > ${w.to}: t = 1`).toEqual({ maxDiff: 0, differing: 0 });
    expect((await diff(page, "before", "middle")).differing, `${w.from} > ${w.to}: the dissolve is under way halfway`).toBeGreaterThan(0);
  }
});

test("no overlays anywhere in the film", async ({ page }) => {
  await openFilm(page, { clock: "" });
  const { chapters } = await timeline(page);
  for (const c of chapters) {
    for (const p of steps(c.startP, c.endP, 4)) {
      await holdAt(page, p);
      await settle(page);
      expect(await page.evaluate(() => window.homewardStage!.frame!.overlays.length), `${c.id} at p ${p.toFixed(4)}`).toBe(0);
    }
  }
});

test("scrolling 40 steps forward and 40 back draws the same frames, none blank", async ({ page }) => {
  await openFilm(page, { clock: "" });
  const { chapters } = await timeline(page);
  // From the eye through its portal into the valley, and through the page flips into the sea.
  for (const [fromId, toId] of [
    ["c02-eye", "c04-descent"],
    ["c07-pages", "c08-sea-alive"],
  ]) {
    const from = chapters.find((c) => c.id === fromId)!;
    const to = chapters.find((c) => c.id === toId)!;
    const positions = steps(from.startP + (from.endP - from.startP) * 0.5, to.startP + (to.endP - to.startP) * 0.3, 40);
    const forward: string[] = [];
    for (const p of positions) {
      await scrollToP(page, p);
      await settle(page);
      const s = await shot(page);
      expectPicture(s, `${fromId} to ${toId}, p ${p.toFixed(5)} forward`);
      forward.push(s.hash);
    }
    const back: string[] = [];
    for (const [k, p] of [...positions.entries()].reverse()) {
      await scrollToP(page, p);
      await settle(page);
      const s = await shot(page);
      expectPicture(s, `${fromId} to ${toId}, p ${p.toFixed(5)} back`);
      back[k] = s.hash;
    }
    expect(back, `${fromId} to ${toId}: the same frames both ways`).toEqual(forward);
  }
});

test("keyboard jumps land at once and captions do not rise", async ({ page }) => {
  await openFilm(page, { clock: "" });
  await page.keyboard.press("End");
  const atEnd = await page.evaluate(() => Math.abs(window.scrollY - (document.documentElement.scrollHeight - window.innerHeight)));
  expect(atEnd, "End lands at the bottom straight away").toBeLessThanOrEqual(1);
  await page.keyboard.press("Home");
  expect(await page.evaluate(() => window.scrollY), "Home lands at the top straight away").toBe(0);

  await page.keyboard.press("ArrowDown");
  await settle(page);
  const caption = page.locator('[data-chapter="c02-eye"]');
  await expect.poll(async () => Number(await caption.evaluate((el) => el.style.opacity || "0")), { timeout: 5_000 }).toBeGreaterThan(0.99);
  expect(await caption.evaluate((el) => el.style.transform)).toBe("");
});
