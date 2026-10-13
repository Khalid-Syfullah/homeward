import { expect, test, type Page } from "@playwright/test";
import { site } from "../src/content/story";
import { openFilm, timeline } from "./stage";

/**
 * Keyboard navigation, with normal motion (the jumps scroll smoothly and the clock follows): the arrow
 * keys step through the chapter stops and back, Home and End go to the ends, the tab order runs from the
 * skip link through the wordmark, the ten chapter buttons and the sound toggle, the skip link lands on
 * the end panel, and a chapter button jumps to its chapter. The live region names each chapter.
 */

/** Wait until the stage has come to rest in this chapter (the scroll and the clock both still). */
async function restIn(page: Page, chapterId: string) {
  await page.waitForFunction(
    (id) => {
      const f = window.homewardStage?.frame;
      return !!f && f.chapter.id === id && f.p === f.target && f.velocity === 0;
    },
    chapterId,
    { timeout: 15_000 },
  );
}

/** Wait until the stage has come to rest at progress p (within half a pixel of scroll). */
async function restAt(page: Page, p: number) {
  await page.waitForFunction(
    (p) => {
      const f = window.homewardStage?.frame;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return !!f && Math.abs(f.target - p) * max <= 0.5 && f.p === f.target && f.velocity === 0;
    },
    p,
    { timeout: 15_000 },
  );
}

test("the arrow keys step through every chapter and back; Home and End go to the ends", async ({ page }) => {
  await openFilm(page, { clock: "" });
  const { chapters } = await timeline(page);
  const status = page.getByRole("status");

  for (let i = 1; i < chapters.length; i++) {
    await page.keyboard.press("ArrowDown");
    await restIn(page, chapters[i].id);
    await expect(status).toHaveText(
      site.a11y.announce.replace("{n}", String(i + 1)).replace("{total}", String(chapters.length)).replace("{title}", chapters[i].title),
    );
  }
  // One more goes to the end screen.
  await page.keyboard.press("ArrowDown");
  await restAt(page, 1);
  await expect(page.locator("#end")).toBeVisible();

  for (let i = chapters.length - 1; i >= 0; i--) {
    await page.keyboard.press("ArrowUp");
    await restIn(page, chapters[i].id);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.keyboard.press("End");
  await restAt(page, 1);
  await page.keyboard.press("Home");
  await restAt(page, 0);
  await page.keyboard.press("PageDown");
  await restIn(page, chapters[1].id);
  await page.keyboard.press("PageUp");
  await restAt(page, 0);
});

test("the tab order runs skip link, wordmark, chapters, sound; the skip link lands on the end panel", async ({ page, browserName }) => {
  await openFilm(page, { clock: "" });
  const { chapters } = await timeline(page);
  // Safari's engine moves Tab between form controls only, unless Option is held (the macOS default).
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";

  await page.keyboard.press(tab);
  const skip = page.getByRole("link", { name: site.skip });
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box!.y, "the skip link comes into view when focused").toBeGreaterThanOrEqual(0);

  await page.keyboard.press(tab);
  await expect(page.getByRole("link", { name: site.a11y.wordmark })).toBeFocused();
  for (const c of chapters) {
    await page.keyboard.press(tab);
    await expect(page.getByRole("button", { name: `${c.index + 1}. ${c.title}`, exact: true })).toBeFocused();
  }
  await page.keyboard.press(tab);
  await expect(page.getByRole("button", { name: site.sound.off })).toBeFocused();

  await skip.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#end")).toBeFocused({ timeout: 15_000 });
  await restAt(page, 1);
  await expect(page.getByRole("button", { name: site.replay })).toBeVisible();
});

test("a chapter button on the rail jumps to its chapter", async ({ page }) => {
  await openFilm(page, { clock: "" });
  const button = page.getByRole("button", { name: "5. The house" });
  await button.focus();
  await page.keyboard.press("Enter");
  await restIn(page, "c05-enter");
  await expect(button).toHaveAttribute("aria-current", "step");
});
