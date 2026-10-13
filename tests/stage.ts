import { expect, type Page } from "@playwright/test";
import type { AnchorsOnScreen } from "../src/stage/engine";

/**
 * Helpers for the browser tests. The page runs with ?test=1, which exposes the stage engine as
 * window.homewardStage (src/stage/engine.ts): the tests hold the film at a progress p or inside a join,
 * wait until the canvas shows the complete picture for it, and read the canvas back.
 *
 * ?clock=1500 holds the ambient clock (the breath and the overlay loops), so every picture is a pure
 * function of p and two reads of the same p must give the same pixels.
 */

/** The fixed ambient clock the pixel tests run at, in ms. */
export const CLOCK_MS = 1500;

/** One read of the canvas, summarised in the page (the pixels stay there). */
export interface Shot {
  /** 64 bits of hash over every RGBA byte. */
  hash: string;
  /** Device pixels. */
  width: number;
  height: number;
  /** The smallest alpha anywhere: 255 means no pixel is transparent. */
  minAlpha: number;
  /** Darkest and brightest luma, 0..255. */
  minLuma: number;
  maxLuma: number;
  /** Colours in use, counted on a grid of 16 levels per channel. */
  colours: number;
  /** The canvas has drawn (data-ready) and is visible. */
  shown: boolean;
}

export interface Timeline {
  totalVh: number;
  filmEndP: number;
  chapters: { id: string; index: number; title: string; startP: number; endP: number; joinOut: string }[];
  joins: { from: string; to: string; type: string; startP: number; boundaryP: number; endP: number }[];
}

/** Open the film with the test API on, the ambient clock held, and any other URL parameters. */
export async function openFilm(page: Page, params: Record<string, string | number> = {}) {
  const query = new URLSearchParams({ test: "1", clock: String(CLOCK_MS) });
  for (const [key, value] of Object.entries(params)) {
    if (value === "") query.delete(key);
    else query.set(key, String(value));
  }
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => window.homewardStage?.frame != null);
}

export function timeline(page: Page): Promise<Timeline> {
  return page.evaluate(() => window.homewardStage!.timeline());
}

/** Hold the film at p, optionally pretending the page scrolls at v viewport heights per second. */
export async function holdAt(page: Page, p: number, v: number | null = null) {
  await page.evaluate(([p, v]) => window.homewardStage!.holdAt(p, v), [p, v] as const);
}

/** Hold inside the join out of a chapter at join time t (0 and 1 are drawn through the join). */
export async function holdJoin(page: Page, from: string, t: number, v: number | null = null) {
  const held = await page.evaluate(([from, t, v]) => window.homewardStage!.holdJoin(from, t, v), [from, t, v] as const);
  expect(held, `${from} has a join in this story`).toBe(true);
}

/**
 * Wait until the canvas shows the complete picture for the held position (the exact frames, all at rest).
 * On a timeout the error says which part of that was still missing.
 */
export async function settle(page: Page, timeout = 30_000) {
  try {
    await page.waitForFunction(() => window.homewardStage!.settled(), undefined, { timeout });
  } catch (error) {
    const report = await page.evaluate(() => window.homewardStage?.settleReport() ?? null).catch(() => null);
    throw new Error(`the picture did not settle within ${timeout} ms: ${JSON.stringify(report)}`, { cause: error });
  }
}

/** Read the canvas back after a fresh draw and summarise it; `keep` stores the pixels in the page for diff(). */
export function shot(page: Page, keep?: string): Promise<Shot> {
  return page.evaluate((keep) => {
    const capture = window.homewardStage!.capture();
    if (!capture) throw new Error("the canvas has no picture to read back");
    const { data, width, height } = capture;
    const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    let minAlpha = 255;
    let minLuma = 255;
    let maxLuma = 0;
    let colours = 0;
    const grid = new Uint8Array(4096);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = Math.imul(h2 ^ w, 0x85ebca6b);
      h2 ^= h2 >>> 13;
      const r = w & 255;
      const g = (w >>> 8) & 255;
      const b = (w >>> 16) & 255;
      const a = w >>> 24;
      if (a < minAlpha) minAlpha = a;
      const luma = (r * 54 + g * 183 + b * 19) >> 8;
      if (luma < minLuma) minLuma = luma;
      if (luma > maxLuma) maxLuma = luma;
      const cell = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      if (!grid[cell]) {
        grid[cell] = 1;
        colours++;
      }
    }
    if (keep) {
      const store = window as unknown as { __homewardShots?: Record<string, typeof capture> };
      (store.__homewardShots ??= {})[keep] = capture;
    }
    const canvas = document.querySelector("canvas");
    const shown = !!canvas && canvas.hasAttribute("data-ready") && getComputedStyle(canvas).visibility === "visible";
    const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
    return { hash: hex(h1) + hex(h2), width, height, minAlpha, minLuma, maxLuma, colours, shown };
  }, keep);
}

/** Compare two kept reads pixel by pixel: the largest difference in any channel, and how many pixels differ. */
export function diff(page: Page, a: string, b: string): Promise<{ maxDiff: number; differing: number }> {
  return page.evaluate(
    ([a, b]) => {
      const store = (window as unknown as { __homewardShots?: Record<string, { width: number; height: number; data: Uint8Array }> }).__homewardShots ?? {};
      const x = store[a];
      const y = store[b];
      if (!x || !y) throw new Error(`no kept read named ${x ? b : a}`);
      if (x.width !== y.width || x.height !== y.height) return { maxDiff: 255, differing: Math.max(x.width * x.height, y.width * y.height) };
      let maxDiff = 0;
      let differing = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(x.data[i + c] - y.data[i + c]));
        if (d > 0) differing++;
        if (d > maxDiff) maxDiff = d;
      }
      return { maxDiff, differing };
    },
    [a, b] as const,
  );
}

/** Average colour of a kept read in a square around a point given in CSS pixels. */
export function sample(page: Page, name: string, x: number, y: number, radiusCss = 3): Promise<{ r: number; g: number; b: number; luma: number }> {
  return page.evaluate(
    ([name, x, y, radiusCss]) => {
      const store = (window as unknown as { __homewardShots?: Record<string, { width: number; height: number; data: Uint8Array }> }).__homewardShots ?? {};
      const shot = store[name];
      if (!shot) throw new Error(`no kept read named ${name}`);
      const scale = shot.width / window.innerWidth;
      const cx = Math.round(x * scale);
      const cy = Math.round(y * scale);
      const radius = Math.max(1, Math.round(radiusCss * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let py = cy - radius; py <= cy + radius; py++) {
        for (let px = cx - radius; px <= cx + radius; px++) {
          if (px < 0 || py < 0 || px >= shot.width || py >= shot.height) continue;
          const i = (py * shot.width + px) * 4;
          r += shot.data[i];
          g += shot.data[i + 1];
          b += shot.data[i + 2];
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      return { r, g, b, luma: (r * 54 + g * 183 + b * 19) / 256 };
    },
    [name, x, y, radiusCss] as const,
  );
}

export function anchorsOf(page: Page, chapter: string): Promise<AnchorsOnScreen | null> {
  return page.evaluate((chapter) => window.homewardStage!.anchors(chapter), chapter);
}

/** A picture, not a blank or see-through canvas. */
export function expectPicture(s: Shot, where: string) {
  expect(s.shown, `${where}: the canvas has drawn and is visible`).toBe(true);
  expect(s.minAlpha, `${where}: no transparent pixel`).toBe(255);
  expect(s.maxLuma - s.minLuma, `${where}: not a blank frame (luma range)`).toBeGreaterThan(24);
  expect(s.colours, `${where}: not a blank frame (colours in use)`).toBeGreaterThan(24);
}

/** The steps of a scrub across [from, to]: steps + 1 positions, both ends included. */
export function steps(from: number, to: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, k) => from + ((to - from) * k) / count);
}
