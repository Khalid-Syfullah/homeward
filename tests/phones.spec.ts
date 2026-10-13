import { expect, test } from "@playwright/test";
import { tune } from "../src/content/story";
import { expectPicture, holdAt, openFilm, settle, shot, timeline } from "./stage";

/**
 * Phones: the 768 tier, the canvas at a device pixel ratio of at most tune.dprCapPhone, the captions in
 * the lower third and the rail reduced to a thin bar, at two phone sizes held upright and one sideways,
 * each at a device pixel ratio of 3. A desktop run checks the other side of the same rules.
 */
const PHONES = [
  { width: 390, height: 844, name: "390x844" },
  { width: 360, height: 640, name: "360x640" },
  { width: 844, height: 390, name: "844x390 (sideways)" },
];

for (const phone of PHONES) {
  test.describe(`phone ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

    test("plays the 768 tier on a canvas capped at the phone pixel ratio", async ({ page }) => {
      await openFilm(page);
      await holdAt(page, 0.3);
      await settle(page);
      expectPicture(await shot(page), `${phone.name} at p 0.3`);
      const { store, compositor } = await page.evaluate(() => window.homewardStage!.stats());
      expect(store?.tier).toBe(768);
      expect(store?.tierReason).toBe("phone");
      expect(compositor?.width).toBe(Math.round(phone.width * tune.dprCapPhone));
      expect(compositor?.height).toBe(Math.round(phone.height * tune.dprCapPhone));
      const frame = await page.evaluate(() => {
        const f = window.homewardStage!.frame!;
        return { dpr: f.dpr, phone: f.phone };
      });
      expect(frame).toEqual({ dpr: tune.dprCapPhone, phone: true });
    });

    test("captions sit in the lower third, inside the screen", async ({ page }) => {
      await openFilm(page);
      // The caption box, and its title and line (the soft ink wash behind them reaches past the box on purpose).
      const boxes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("[data-chapter]")].map((el) => {
          const r = el.getBoundingClientRect();
          const text = [...el.querySelectorAll<HTMLElement>("h2, p")].map((t) => {
            const b = t.getBoundingClientRect();
            return { left: b.left, right: b.right, overflow: t.scrollWidth - t.clientWidth };
          });
          return { id: el.dataset.chapter!, top: r.top, bottom: r.bottom, left: r.left, right: r.right, text };
        }),
      );
      expect(boxes.length).toBe((await timeline(page)).chapters.length);
      for (const box of boxes) {
        expect(box.top, `${box.id}: the caption starts in the lower third`).toBeGreaterThanOrEqual((phone.height * 2) / 3);
        expect(box.bottom, `${box.id}: the caption ends on screen`).toBeLessThanOrEqual(phone.height);
        expect(box.left, `${box.id}: inside on the left`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${box.id}: inside on the right`).toBeLessThanOrEqual(phone.width);
        expect(box.text.length).toBe(2);
        for (const t of box.text) {
          expect(t.left, `${box.id}: the words start on screen`).toBeGreaterThanOrEqual(0);
          expect(t.right, `${box.id}: the words end on screen`).toBeLessThanOrEqual(phone.width);
          expect(t.overflow, `${box.id}: no words run past their line`).toBeLessThanOrEqual(0);
        }
      }
    });

    test("the rail is a thin bar with nothing for a thumb to catch", async ({ page }) => {
      await openFilm(page);
      const rail = page.getByRole("navigation", { name: "Chapters" });
      const box = await rail.boundingBox();
      expect(box!.width, "the rail is a thin bar").toBeLessThanOrEqual(4);
      const ticks = await page.evaluate(() => {
        const list = document.querySelector("nav ol")!;
        const buttons = [...list.querySelectorAll("button")];
        const hit = buttons.map((b) => {
          const r = b.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return at === b || b.contains(at);
        });
        return { opacity: getComputedStyle(list).opacity, buttons: buttons.length, hittable: hit.filter(Boolean).length };
      });
      expect(ticks.opacity, "the chapter ticks are out of sight").toBe("0");
      expect(ticks.hittable, "no chapter button catches a touch").toBe(0);

      // Still there for a screen reader and the keyboard: with focus on one, the rail opens out again.
      const first = page.getByRole("button", { name: "1. The road" });
      await first.focus();
      await expect(first).toBeFocused();
      expect((await rail.boundingBox())!.width, "the rail opens out around the focused button").toBeGreaterThan(20);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector("nav ol")!).opacity)).toBe("1");
    });

    test("nothing runs off the side of the screen", async ({ page }) => {
      await openFilm(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test.describe("desktop 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test("plays the 1440 tier at the desktop pixel ratio cap, with the full rail", async ({ page }) => {
    await openFilm(page);
    await holdAt(page, 0.3);
    await settle(page);
    const { store, compositor } = await page.evaluate(() => window.homewardStage!.stats());
    expect(store?.tier).toBe(1440);
    expect(compositor?.width).toBe(Math.round(1440 * Math.min(2, tune.dprCapDesktop)));
    const box = await page.getByRole("navigation", { name: "Chapters" }).boundingBox();
    expect(box!.width).toBeGreaterThan(20);
    await expect(page.getByRole("button", { name: "5. The house" })).toBeVisible();
  });
});
