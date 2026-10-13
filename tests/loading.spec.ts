import { expect, test, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { CLOCK_MS } from "./stage";

/**
 * The first paint and the handover. Before any script runs the page shows the loading frame: the film's
 * opening frame as a plain image, placed by the canvas's own cover fit and under the same vignette. The
 * canvas must then take over without a visible change. The top of the film is shot twice, once with the
 * app's scripts blocked (so only the loading frame shows) and once with the canvas drawn, with everything
 * else on the page hidden, and the two shots are compared. Only resampling may differ (the browser scales
 * the image with its own filter, the canvas with bilinear sampling); a frame placed even a few pixels off,
 * or a missing vignette, fails.
 */
const SIZES = [
  { width: 1440, height: 900, name: "1440x900" },
  { width: 2560, height: 1080, name: "2560x1080 (ultrawide)" },
  { width: 390, height: 844, name: "390x844 (phone)" },
];

const HIDE_ALL_BUT_THE_PICTURE = "[data-chrome], [data-chapter], #end { visibility: hidden !important; }";

async function viewportPixels(page: Page) {
  const png = await page.screenshot();
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function open(browser: Browser, baseURL: string, size: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
  return { context, page: await context.newPage() };
}

for (const size of SIZES) {
  test(`at ${size.name} the canvas takes over from the loading frame without a visible change`, async ({ browser, baseURL }) => {
    // The loading frame alone: the HTML as the server sends it, with the app's scripts blocked.
    const before = await open(browser, baseURL!, size);
    await before.page.route("**/_next/static/chunks/*.js", (route) => route.abort());
    await before.page.goto(`/?test=1&p=0&clock=${CLOCK_MS}`);
    await before.page.addStyleTag({ content: HIDE_ALL_BUT_THE_PICTURE });
    await before.page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>("[data-loading-frame] img");
      return !!img && img.complete && img.naturalWidth > 0;
    });
    expect(await before.page.evaluate(() => document.querySelector("canvas")?.hasAttribute("data-ready"))).toBe(false);
    const loading = await viewportPixels(before.page);
    await before.context.close();

    // The canvas at the top of the film, as the engine draws it.
    const after = await open(browser, baseURL!, size);
    await after.page.goto(`/?test=1&p=0&clock=${CLOCK_MS}`);
    await after.page.waitForFunction(() => window.homewardStage?.settled());
    await after.page.addStyleTag({ content: HIDE_ALL_BUT_THE_PICTURE });
    expect(await after.page.evaluate(() => getComputedStyle(document.querySelector("[data-loading-frame]")!).display)).toBe("none");
    const canvas = await viewportPixels(after.page);
    await after.context.close();

    expect(canvas.width).toBe(loading.width);
    expect(canvas.height).toBe(loading.height);
    // The whole picture, and its four corners on their own (where a vignette shows).
    const { width, height } = canvas;
    const cornerW = Math.round(width * 0.08);
    const cornerH = Math.round(height * 0.08);
    let sum = 0;
    let far = 0;
    let cornerSum = 0;
    let cornerCount = 0;
    for (let i = 0; i < canvas.data.length; i++) {
      const d = Math.abs(canvas.data[i] - loading.data[i]);
      sum += d;
      if (d > 32) far++;
      const pixel = Math.floor(i / 3);
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if ((x < cornerW || x >= width - cornerW) && (y < cornerH || y >= height - cornerH)) {
        cornerSum += d;
        cornerCount++;
      }
    }
    const mean = sum / canvas.data.length;
    const farShare = far / canvas.data.length;
    const corners = cornerSum / cornerCount;
    console.log(
      `${size.name}: mean difference ${mean.toFixed(2)} levels (corners ${corners.toFixed(2)}), ${(farShare * 100).toFixed(3)} percent of values off by more than 32`,
    );
    expect(mean, "the two pictures match on average").toBeLessThan(2);
    expect(corners, "the corners match too (the vignette)").toBeLessThan(1.5);
    expect(farShare, "almost no value is far off (resampling only)").toBeLessThan(0.002);
  });
}
