#!/usr/bin/env node
// npm run perf: measures the production build against the budget in src/content/story.ts (tune.budget)
// and prints the numbers docs/PERF.md records. Run npm run build first.
//
//   1. First paint, cold cache, on Chrome DevTools' "Fast 4G" preset (9 Mbps down and 1.5 Mbps up at 90
//      percent, 60 ms of latency times 2.75: 1,012,500 and 168,750 bytes per second, 165 ms per request).
//      Desktop 1440x900 at 2x, and a phone 390x844 at 3x with the CPU slowed 4x. It records when the loading
//      frame is painted (its Element Timing entry, homeward-loading-frame: a full-screen image is not a
//      largest-contentful-paint candidate), when the canvas first draws (homeward:first-frame), when the
//      first-paint frames are all in (homeward:first-paint), and the bytes: the loading frame plus the
//      first-paint frames (the budget), and everything transferred by then.
//   2. Scrubbing: the whole film scrolled at a steady speed with frames from the local server, desktop
//      1440x900 at 2x: frame intervals (frame rate, 95th percentile, longest, frames over 1.5 vsyncs), the
//      stage's own step time per frame, and how often a stand-in frame was on screen. Then again with the
//      CPU slowed 4x, and on a phone 390x844 at 3x (the 768 tier) with the CPU slowed 4x.
//      Before that the same scroll driver runs on a trivial page: when the browser itself paces scrolling
//      below the target (Chrome's energy saver, on battery at 20 percent or less, holds it at 30 Hz), the
//      frame-rate line is reported as SKIP rather than judged.
//   3. Memory during each scrub: decoded frames against tune.memoryCapMb, encoded frames against
//      tune.blobCapMb, GPU textures, and the JavaScript heap.
//
//   npm run perf                          starts next start on a free port and measures it
//   npm run perf -- --url http://host:3000  measures a server that is already running
//   npm run perf -- --json out.json       also writes the numbers as JSON
//   npm run perf -- --headed              uses a visible window (the display's own refresh rate)
//   npm run perf -- --speed 60            scrub speed in viewport heights per second (default 60)
//
// The browser is Playwright's Chromium (new headless, so WebGL runs on the machine's GPU where it has one).
// Exit code 1 when a budget line fails.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { chromium } from "@playwright/test";
import { loadStory, repoRoot } from "./lib/load-ts.mjs";

const FAST_4G = { offline: false, latency: 60 * 2.75, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 };
const MB = 1e6;
const MIB = 1024 * 1024;

/** Frame sizes docs/EXPORT.md expects from real art, and the most the import's budget lets through, in bytes. */
const REAL_FRAME = { 1440: 90e3, 768: 35e3 };

function parseArgs(argv) {
  const args = { url: null, json: null, headed: false, speed: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--headed") args.headed = true;
    else if (a === "--speed") args.speed = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/perf.mjs [--url <base url>] [--json <file>] [--headed] [--speed <vh per s>]");
      process.exit(0);
    } else {
      console.error(`perf: unknown argument ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.speed) || args.speed <= 0) args.speed = 60;
  return args;
}

const kb = (bytes) => `${(bytes / 1e3).toFixed(0)} KB`;
const mb = (bytes) => `${(bytes / MB).toFixed(2)} MB`;
const mib = (bytes) => `${(bytes / MIB).toFixed(1)} MiB`;
const ms = (v) => (v == null ? "n/a" : `${Math.round(v)} ms`);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer() {
  if (!existsSync(path.join(repoRoot, ".next", "BUILD_ID"))) {
    console.error("perf: no production build. Run npm run build first.");
    process.exit(2);
  }
  const port = await freePort();
  const bin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [bin, "start", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return { url, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("next start did not come up");
}

async function launch(headed) {
  try {
    return await chromium.launch({ channel: "chromium", headless: !headed });
  } catch {
    return chromium.launch({ headless: !headed });
  }
}

/** The WebGL renderer the page gets (to say what the numbers were measured on). */
async function renderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return "no WebGL";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  });
}

// ---------- 1. first paint ----------

async function firstPaint(browser, base, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.dpr,
    isMobile: profile.mobile,
    hasTouch: profile.mobile,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", FAST_4G);
  if (profile.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });

  await page.goto(`${base}/?test=1`, { waitUntil: "commit" });
  await page.waitForFunction(() => performance.getEntriesByName("homeward:first-paint").length > 0, undefined, { timeout: 120_000 });

  const result = await page.evaluate(async () => {
    const painted = await new Promise((resolve) => {
      const observer = new PerformanceObserver((list) => {
        const entry = list.getEntries().find((e) => e.identifier === "homeward-loading-frame");
        if (entry) {
          observer.disconnect();
          resolve({ time: entry.renderTime || entry.startTime, url: entry.url || "" });
        }
      });
      observer.observe({ type: "element", buffered: true });
      setTimeout(() => resolve(null), 2000);
    });
    const mark = (name) => performance.getEntriesByName(name)[0]?.startTime ?? null;
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource").map((r) => ({
      url: r.name,
      type: r.initiatorType,
      start: r.startTime,
      end: r.responseEnd,
      bytes: r.transferSize,
      body: r.encodedBodySize,
    }));
    const stats = window.homewardStage?.stats() ?? null;
    return {
      painted,
      firstFrame: mark("homeward:first-frame"),
      firstPaint: mark("homeward:first-paint"),
      document: { bytes: nav?.transferSize ?? 0, end: nav?.responseEnd ?? 0 },
      resources,
      tier: stats?.store?.tier ?? null,
      canvas: stats?.compositor ? `${stats.compositor.width}x${stats.compositor.height} ${stats.compositor.kind}` : null,
    };
  });
  const gpu = await renderer(page);
  await context.close();

  const isFrame = (url) => /\/frames\/[^/]+\/\d+\/f_\d+\.webp/.test(url);
  const until = result.firstPaint ?? Infinity;
  const early = result.resources.filter((r) => r.start <= until);
  // A frame fetched twice (the loading frame, then the store's fetch from the cache) counts once.
  const frames = new Map();
  for (const r of early.filter((r) => isFrame(r.url))) frames.set(r.url, Math.max(frames.get(r.url) ?? 0, r.bytes));
  const frameBytes = [...frames.values()].reduce((a, b) => a + b, 0);
  const tiers = { 1440: 0, 768: 0 };
  for (const url of frames.keys()) {
    const tier = Number(url.match(/\/(\d+)\/f_\d+\.webp/)[1]);
    tiers[tier] = (tiers[tier] ?? 0) + 1;
  }
  const byKind = {};
  const kindOf = (r) =>
    isFrame(r.url) ? "frames" : r.url.endsWith(".woff2") ? "fonts" : r.url.endsWith(".js") ? "scripts" : r.url.endsWith(".css") ? "styles" : r.url.includes("manifest.json") ? "manifests" : "other";
  for (const r of early) byKind[kindOf(r)] = (byKind[kindOf(r)] ?? 0) + r.bytes;
  byKind.document = result.document.bytes;
  byKind.frames = frameBytes;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const projected = Object.entries(tiers).reduce((sum, [tier, n]) => sum + n * (REAL_FRAME[tier] ?? 0), 0);
  return {
    profile: profile.name,
    gpu,
    tier: result.tier,
    canvas: result.canvas,
    loadingFrame: result.painted?.url.replace(/^https?:\/\/[^/]+/, "") ?? null,
    loadingFrameMs: result.painted?.time ?? null,
    firstFrameMs: result.firstFrame,
    firstPaintMs: result.firstPaint,
    frames: { count: frames.size, byTier: tiers, bytes: frameBytes, projectedRealBytes: projected },
    bytes: { total, byKind },
  };
}

// ---------- 2 and 3. scrubbing and memory ----------

/**
 * The browser's own frame pacing while a page scrolls: the same driver on a trivial page (one tall
 * gradient). A browser saving power (Chrome's energy saver, on battery at 20 percent or less) paces
 * scrolling pages at 30 Hz whatever they draw, and then a 60 fps target cannot be judged.
 */
async function pacing(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent('<div style="height: 40000px; background: linear-gradient(#2f5d3a, #8fb8d8)"></div>');
  const median = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const intervals = [];
        let last = 0;
        let y = 0;
        const tick = (now) => {
          if (last) intervals.push(now - last);
          y += last ? (540 * (now - last)) / 1000 : 0;
          last = now;
          window.scrollTo(0, y);
          if (intervals.length < 180) requestAnimationFrame(tick);
          else resolve(intervals.sort((a, b) => a - b)[90]);
        };
        requestAnimationFrame(tick);
      }),
  );
  await context.close();
  return median;
}

async function scrub(browser, base, { profile, speed }) {
  const { cpu } = profile;
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.dpr,
    isMobile: profile.mobile,
    hasTouch: profile.mobile,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(`${base}/?test=1`);
  await page.waitForFunction(() => performance.getEntriesByName("homeward:first-paint").length > 0, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.homewardStage?.settled(), undefined, { timeout: 60_000 });
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  await cdp.send("Runtime.enable");

  let heapPeak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const { usedSize } = await cdp.send("Runtime.getHeapUsage");
        heapPeak = Math.max(heapPeak, usedSize);
      } catch {
        // the page is closing
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  const run = await page.evaluate(async (speedVh) => {
    const stage = window.homewardStage;
    stage.resetTiming();
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pxPerSecond = (speedVh * window.innerHeight) / 100;
    const intervals = [];
    const peak = { decoded: 0, encoded: 0, textures: 0, frames: 0 };
    let standIns = 0;
    let blank = 0;
    let ticks = 0;
    let longFrames = 0;
    const observer = new PerformanceObserver((list) => (longFrames += list.getEntries().length));
    try {
      observer.observe({ type: "long-animation-frame" });
    } catch {
      // not in this browser
    }
    return new Promise((resolve) => {
      let last = 0;
      let start = 0;
      let y = 0;
      const tick = (now) => {
        const dt = (now - last) / 1000;
        intervals.push(now - last);
        last = now;
        y = Math.min(max, y + pxPerSecond * dt);
        window.scrollTo(0, y);
        const f = stage.frame;
        ticks++;
        if (!f?.shown) blank++;
        else if (!f.shown.exact || (f.join && (!f.join.out?.exact || !f.join.into?.exact))) standIns++;
        const s = stage.stats();
        peak.decoded = Math.max(peak.decoded, s.store?.decodedBytes ?? 0);
        peak.encoded = Math.max(peak.encoded, s.store?.encodedBytes ?? 0);
        peak.frames = Math.max(peak.frames, s.store?.frames ?? 0);
        peak.textures = Math.max(peak.textures, s.compositor?.textureBytes ?? 0);
        if (y < max) requestAnimationFrame(tick);
        else {
          observer.disconnect();
          const s = stage.stats();
          resolve({
            seconds: (now - start) / 1000,
            intervals,
            ticks,
            standIns,
            blank,
            longFrames,
            peak,
            caps: { decoded: s.store?.capBytes ?? 0, encoded: s.store?.encodedCapBytes ?? 0 },
            render: s.render,
            tier: s.store?.tier ?? null,
          });
        }
      };
      requestAnimationFrame((now) => {
        last = now;
        start = now;
        requestAnimationFrame(tick);
      });
    });
  }, speed);
  sampling = false;
  await sampler;
  const gpu = await renderer(page);
  await context.close();

  const sorted = [...run.intervals].sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const vsync = pct(0.5);
  const slow = run.intervals.filter((v) => v > vsync * 1.5).length;
  return {
    profile: profile.name,
    cpu,
    speedVh: speed,
    gpu,
    tier: run.tier,
    seconds: run.seconds,
    fps: run.intervals.length / run.seconds,
    medianMs: vsync,
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    longestMs: sorted.at(-1),
    slowFrames: slow,
    slowShare: slow / run.intervals.length,
    longAnimationFrames: run.longFrames,
    standInShare: run.standIns / run.ticks,
    blankFrames: run.blank,
    render: run.render,
    memory: { ...run.peak, caps: run.caps, heapPeak },
  };
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { tune } = await loadStory();
  const budget = tune.budget;
  const server = args.url ? { url: args.url.replace(/\/$/, ""), stop: () => {} } : await startServer();
  const browser = await launch(args.headed);
  const failures = [];
  const check = (ok, line) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${line}`);
    if (!ok) failures.push(line);
  };

  try {
    console.log(`perf: ${server.url}, Chromium ${browser.version()}${args.headed ? " (headed)" : ""}\n`);
    const paints = [];
    for (const profile of [
      { name: "desktop 1440x900 @2x, Fast 4G", viewport: { width: 1440, height: 900 }, dpr: 2, mobile: false, cpu: 1 },
      { name: "phone 390x844 @3x, Fast 4G, CPU 4x slower", viewport: { width: 390, height: 844 }, dpr: 3, mobile: true, cpu: 4 },
    ]) {
      const r = await firstPaint(browser, server.url, profile);
      paints.push(r);
      console.log(`First paint, ${r.profile} (${r.tier} tier, canvas ${r.canvas}, ${r.gpu})`);
      console.log(
        `  loading frame (${r.loadingFrame ?? "none"}) painted ${ms(r.loadingFrameMs)}, canvas first frame ${ms(r.firstFrameMs)}, first-paint frames in ${ms(r.firstPaintMs)}`,
      );
      console.log(
        `  ${r.frames.count} frames (${Object.entries(r.frames.byTier)
          .filter(([, n]) => n)
          .map(([t, n]) => `${n} at ${t}`)
          .join(", ")}): ${kb(r.frames.bytes)}; at the sizes docs/EXPORT.md expects from real art: ${kb(r.frames.projectedRealBytes)}`,
      );
      console.log(
        `  everything by then: ${mb(r.bytes.total)} (${Object.entries(r.bytes.byKind)
          .map(([k, v]) => `${k} ${kb(v)}`)
          .join(", ")})`,
      );
      check(r.frames.bytes <= budget.firstPaintMb * MB, `first-paint payload ${mb(r.frames.bytes)} (loading frame and ${r.frames.count} frames) under ${budget.firstPaintMb} MB`);
      check(
        r.frames.projectedRealBytes + (r.bytes.total - r.frames.bytes) <= budget.firstPaintMb * MB,
        `with real art (docs/EXPORT.md sizes) and the page itself: ${mb(r.frames.projectedRealBytes + r.bytes.total - r.frames.bytes)} under ${budget.firstPaintMb} MB`,
      );
      check(r.loadingFrameMs !== null && r.loadingFrameMs <= budget.firstFrameMs, `first frame on screen (the loading frame) at ${ms(r.loadingFrameMs)}, under ${budget.firstFrameMs} ms`);
      check(r.firstFrameMs !== null && r.firstFrameMs <= budget.firstFrameMs, `the canvas's first frame at ${ms(r.firstFrameMs)}, under ${budget.firstFrameMs} ms`);
      console.log("");
    }

    const paceMs = await pacing(browser);
    const paced = paceMs > (1000 / budget.fps) * 1.2;
    console.log(
      `Browser pacing: a trivial scrolling page runs at ${(1000 / paceMs).toFixed(1)} Hz${paced ? " (the browser is saving power: plug in, or charge above 20 percent, to judge the frame rate)" : ""}\n`,
    );

    const scrubs = [];
    const desktop = { viewport: { width: 1440, height: 900 }, dpr: 2, mobile: false };
    for (const profile of [
      { ...desktop, name: "desktop 1440x900 @2x", cpu: 1, fps: true },
      { ...desktop, name: "desktop 1440x900 @2x", cpu: 4, fps: false },
      { name: "phone 390x844 @3x", viewport: { width: 390, height: 844 }, dpr: 3, mobile: true, cpu: 4, fps: false },
    ]) {
      const { cpu } = profile;
      const r = await scrub(browser, server.url, { profile, speed: args.speed });
      scrubs.push(r);
      console.log(`Scrub, ${r.profile}, ${r.speedVh} vh/s for ${r.seconds.toFixed(1)} s${cpu > 1 ? `, CPU ${cpu}x slower` : ""} (${r.tier} tier, ${r.gpu})`);
      console.log(
        `  ${r.fps.toFixed(1)} fps; frame interval median ${r.medianMs.toFixed(1)} ms, 95th percentile ${r.p95Ms.toFixed(1)} ms, 99th ${r.p99Ms.toFixed(1)} ms, longest ${r.longestMs.toFixed(1)} ms; ${r.slowFrames} frames over 1.5 vsyncs (${(r.slowShare * 100).toFixed(1)} percent), ${r.longAnimationFrames} long animation frames`,
      );
      console.log(
        `  stage step ${r.render.meanMs.toFixed(2)} ms mean, ${r.render.maxMs.toFixed(1)} ms longest over ${r.render.frames} frames; stand-in frames on screen ${(r.standInShare * 100).toFixed(1)} percent, blank ${r.blankFrames}`,
      );
      console.log(
        `  memory peaks: decoded frames ${mib(r.memory.decoded)} of ${mib(r.memory.caps.decoded)} (${r.memory.frames} frames), encoded ${mib(r.memory.encoded)} of ${mib(r.memory.caps.encoded)}, GPU textures ${mib(r.memory.textures)}, JS heap ${mib(r.memory.heapPeak)}`,
      );
      const where = `${r.profile}${cpu > 1 ? `, CPU ${cpu}x slower` : ""}`;
      if (profile.fps && paced) {
        console.log(`  SKIP  scrubbing at ${r.fps.toFixed(1)} fps: the browser paces any scrolling page at ${(1000 / paceMs).toFixed(1)} Hz, so ${budget.fps} fps cannot be judged`);
      } else if (profile.fps) {
        check(
          r.fps >= budget.fps * 0.95 && r.slowShare <= 0.05,
          `scrubbing at ${r.fps.toFixed(1)} fps with ${(r.slowShare * 100).toFixed(1)} percent of frames late (target ${budget.fps} fps, at most 5 percent late)`,
        );
      }
      check(r.blankFrames === 0, `no blank frame while scrubbing (${where})`);
      check(r.memory.decoded <= r.memory.caps.decoded, `decoded frames ${mib(r.memory.decoded)} within the ${mib(r.memory.caps.decoded)} cap (${where})`);
      check(r.memory.encoded <= r.memory.caps.encoded, `encoded frames ${mib(r.memory.encoded)} within the ${mib(r.memory.caps.encoded)} cap (${where})`);
      console.log("");
    }

    if (args.json) {
      await writeFile(
        args.json,
        `${JSON.stringify({ when: new Date().toISOString(), browser: browser.version(), budget, pacingMs: paceMs, firstPaint: paints, scrub: scrubs }, null, 2)}\n`,
      );
      console.log(`perf: wrote ${args.json}`);
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (failures.length) {
    console.log(`perf: ${failures.length} budget line(s) failed`);
    process.exit(1);
  }
  console.log("perf: every budget line passed");
}

main().catch((err) => {
  console.error(`perf: ${err?.stack ?? err}`);
  process.exit(1);
});
