import { expect, test, type Page } from "@playwright/test";
import { chapters } from "../src/content/story";
import { anchorsOf, holdJoin, openFilm, sample, settle, shot, timeline } from "./stage";

/**
 * The anchors fall inside the viewport at five sizes: the pupil the portal opens from (c02) and the sea
 * photograph the rect join grows (c08), each where its join starts, plus every chapter's focal point.
 * The positions come from the engine's own cover fit; on placeholder frames, which draw the anchors,
 * the canvas is also sampled there: the pupil must read dark, the photograph as sea and not as paper.
 */
const SIZES = [
  { width: 1920, height: 1080, name: "desktop 1920x1080" },
  { width: 1366, height: 768, name: "laptop 1366x768" },
  { width: 768, height: 1024, name: "tablet 768x1024" },
  { width: 390, height: 844, name: "phone 390x844" },
  { width: 360, height: 640, name: "phone 360x640" },
];

/** An anchor must sit at least this share of the viewport away from every edge. */
const MARGIN = 0.1;

const inside = (x: number, y: number, width: number, height: number) =>
  x >= width * MARGIN && x <= width * (1 - MARGIN) && y >= height * MARGIN && y <= height * (1 - MARGIN);

async function placeholderAt(page: Page): Promise<boolean> {
  return page.evaluate(() => window.homewardStage!.stats().chapter?.manifest === "placeholder");
}

/** A frame point on screen, in CSS pixels. */
async function onScreen(page: Page, chapter: string, x: number, y: number) {
  const point = await page.evaluate(([chapter, x, y]) => window.homewardStage!.toScreen(chapter, { x, y }), [chapter, x, y] as const);
  expect(point).not.toBeNull();
  return point!;
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("the pupil and the photograph are inside the viewport where their joins start", async ({ page }) => {
      await openFilm(page);
      const { joins } = await timeline(page);

      for (const chapter of chapters.filter((c) => c.anchors.pupil || c.anchors.photoRect)) {
        if (!joins.some((j) => j.from === chapter.id)) continue;
        await holdJoin(page, chapter.id, 0);
        await settle(page);
        await shot(page, "anchor");
        const a = await anchorsOf(page, chapter.id);
        expect(a, `${chapter.id} is placed`).not.toBeNull();
        if (!a) continue;
        expect(a.width).toBe(size.width);
        expect(a.height).toBe(size.height);
        const placeholder = await placeholderAt(page);

        if (chapter.anchors.pupil) {
          expect(a.pupil, `${chapter.id} has a pupil`).not.toBeNull();
          const { x, y } = a.pupil!;
          expect(inside(x, y, a.width, a.height), `${chapter.id} pupil at ${x.toFixed(0)},${y.toFixed(0)} inside ${size.name}`).toBe(true);
          if (placeholder) {
            // The placeholder pupil is an ink disc; sample its lower half, clear of the chapter number.
            const below = await onScreen(page, chapter.id, chapter.anchors.pupil.x, chapter.anchors.pupil.y + 0.08);
            const c = await sample(page, "anchor", below.x, below.y);
            expect(c.luma, `${chapter.id}: the pupil reads dark on screen (luma ${c.luma.toFixed(0)})`).toBeLessThan(70);
          }
        }

        if (chapter.anchors.photoRect) {
          expect(a.photoRect, `${chapter.id} has a photograph`).not.toBeNull();
          const r = a.photoRect!;
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          expect(inside(cx, cy, a.width, a.height), `${chapter.id} photograph centre at ${cx.toFixed(0)},${cy.toFixed(0)} inside ${size.name}`).toBe(true);
          const visibleW = Math.min(r.x + r.w, a.width) - Math.max(r.x, 0);
          const visibleH = Math.min(r.y + r.h, a.height) - Math.max(r.y, 0);
          expect(visibleW, `${chapter.id}: the photograph spans the middle of the screen`).toBeGreaterThan(Math.min(r.w, a.width) * 0.95);
          expect(visibleH, `${chapter.id}: the photograph shows its whole height`).toBeGreaterThan(r.h * 0.95);
          if (placeholder) {
            // The placeholder photograph is a sea gradient inside a paper border; sample it below the number.
            const { photoRect } = chapter.anchors;
            const point = await onScreen(page, chapter.id, photoRect.x + photoRect.w * 0.42, photoRect.y + photoRect.h * 0.88);
            const c = await sample(page, "anchor", point.x, point.y);
            expect(c.g > c.r && c.b > c.r, `${chapter.id}: the photograph reads as sea, not paper (rgb ${[c.r, c.g, c.b].map((v) => v.toFixed(0)).join(",")})`).toBe(true);
          }
        }
      }
    });

    test("every chapter's focal point is inside the viewport", async ({ page }) => {
      await openFilm(page);
      for (const { id } of (await timeline(page)).chapters) {
        const a = await anchorsOf(page, id);
        expect(a).not.toBeNull();
        const { x, y } = a!.focal;
        expect(inside(x, y, a!.width, a!.height), `${id} focal point at ${x.toFixed(0)},${y.toFixed(0)} inside ${size.name}`).toBe(true);
      }
    });
  });
}
