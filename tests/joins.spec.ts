import { expect, test, type Page } from "@playwright/test";
import { chapters, tune } from "../src/content/story";
import { diff, expectPicture, holdAt, holdJoin, openFilm, settle, shot, timeline } from "./stage";

/**
 * The joins never pop. Each join is drawn through its own program at t = 0 and t = 1 (a held join draws
 * its ends, which scrolling never does) and compared pixel by pixel with the plain frame at the edge of
 * its window: the outgoing chapter at the window's start, the incoming one at its end. The difference
 * must be exactly 0, at rest and at full speed (the speed terms vanish at both ends). Halfway through,
 * the join must differ from both, so the comparison is not passing on a join that draws nothing.
 */

async function expectJoinEnds(page: Page, from: string, speedVh: number | null) {
  const w = (await timeline(page)).joins.find((j) => j.from === from);
  test.skip(!w, `${from} has no join in this story`);
  if (!w) return;
  const label = `${w.from} > ${w.to} (${w.type}${speedVh ? `, at ${speedVh} vh/s` : ", at rest"})`;

  await holdAt(page, w.startP, speedVh);
  await settle(page);
  expectPicture(await shot(page, "before"), `${label}: the frame before the window`);
  await holdJoin(page, w.from, 0, speedVh);
  await settle(page);
  expectPicture(await shot(page, "start"), `${label}: t = 0`);
  expect(await diff(page, "before", "start"), `${label}: t = 0 against the frame before`).toEqual({ maxDiff: 0, differing: 0 });

  await holdAt(page, w.endP, speedVh);
  await settle(page);
  expectPicture(await shot(page, "after"), `${label}: the frame after the window`);
  await holdJoin(page, w.from, 1, speedVh);
  await settle(page);
  expectPicture(await shot(page, "end"), `${label}: t = 1`);
  expect(await diff(page, "after", "end"), `${label}: t = 1 against the frame after`).toEqual({ maxDiff: 0, differing: 0 });

  await holdJoin(page, w.from, 0.5, speedVh);
  await settle(page);
  expectPicture(await shot(page, "middle"), `${label}: t = 0.5`);
  expect((await diff(page, "before", "middle")).differing, `${label}: halfway differs from the start`).toBeGreaterThan(0);
  expect((await diff(page, "after", "middle")).differing, `${label}: halfway differs from the end`).toBeGreaterThan(0);
}

for (const chapter of chapters.filter((c) => c.join !== "none")) {
  test(`the join out of ${chapter.id} is exactly its neighbouring frames at t = 0 and t = 1`, async ({ page }) => {
    await openFilm(page);
    await expectJoinEnds(page, chapter.id, null);
    await expectJoinEnds(page, chapter.id, tune.joins.speedRefVh);
  });
}
