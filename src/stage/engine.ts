import { chapterAt, localT, tune, type Point, type Story, type StoryChapter, type Tier } from "@/content/story";
import { ScrollClock } from "./clock";
import { createCompositor, type Compositor, type CompositorStats, type Layer } from "./compositor";
import { focalFor, isPhoneViewport } from "./fit";
import { chooseTier, FrameStore, MB, type Frame, type FramePick, type StoreStats } from "./frameStore";

/**
 * The stage engine: one requestAnimationFrame loop that reads the scroll into the clock, plans
 * the frame store's loads around the smoothed progress p, has the compositor draw, and then hands
 * the same frame state to every listener (the HUD now; captions, sound and chrome later). The
 * loop only runs while something moves: the clock settling, a frame arriving, or a listener asking
 * for another frame. At rest it stops.
 *
 * URL parameters (development aids):
 *   ?hud=1       the dev HUD
 *   ?p=0.42      freeze progress at 0.42 (the scroll is ignored)
 *   ?tier=768    force a frame tier
 *   ?mem=80      frame memory cap in MB (default tune.memoryCapMb)
 */

export interface StageParams {
  hud: boolean;
  p: number | null;
  tier: Tier | null;
  memMb: number | null;
}

export function readStageParams(search: string): StageParams {
  const q = new URLSearchParams(search);
  const num = (name: string) => {
    const raw = q.get(name);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const p = num("p");
  const tier = num("tier");
  const mem = num("mem");
  return {
    hud: q.get("hud") === "1" || q.get("hud") === "true",
    p: p === null ? null : Math.min(1, Math.max(0, p)),
    tier: tier !== null && (tune.tiers as readonly number[]).includes(tier) ? (tier as Tier) : null,
    memMb: mem !== null && mem > 0 ? mem : null,
  };
}

/** Everything a listener may need about the frame being shown. All of it follows from p. */
export interface StageFrame {
  /** requestAnimationFrame time, in ms. */
  now: number;
  /** Seconds since the previous frame (about 0 on the first frame after rest). */
  dt: number;
  /** Smoothed progress, 0..1. */
  p: number;
  /** Raw scroll progress the clock follows. */
  target: number;
  /** dp/dt in p per second. */
  velocity: number;
  /** Last direction of travel (1 down the page, -1 back up). */
  direction: 1 | -1;
  story: Story;
  chapter: StoryChapter;
  /** Local time 0..1 inside the chapter. */
  t: number;
  /** Frames in the chapter's clip at the tier being loaded. */
  count: number;
  /** Fractional frame index, 0 .. count-1. */
  frame: number;
  /** The frames handed to the compositor this frame (null when none is loaded yet). */
  shown: FramePick | null;
  reducedMotion: boolean;
  frozen: boolean;
  /** Viewport size in CSS pixels, and the device pixel ratio the canvas uses. */
  width: number;
  height: number;
  dpr: number;
  phone: boolean;
}

/** Called once per rendered frame. Return true to ask for another frame (ambient motion). */
export type StageListener = (frame: StageFrame) => boolean | void;

export interface StageStats {
  store: StoreStats | null;
  chapter: ReturnType<FrameStore["chapterStats"]> | null;
  compositor: CompositorStats | null;
}

interface NetworkInformationLike extends EventTarget {
  effectiveType?: string;
}

declare global {
  interface Window {
    /** The stage engine, exposed with ?hud=1 for debugging and browser tests. */
    homewardStage?: StageEngine;
  }
}

export class StageEngine {
  readonly clock = new ScrollClock();
  params: StageParams = { hud: false, p: null, tier: null, memMb: null };

  private story: Story;
  private store: FrameStore | null = null;
  private compositor: Compositor | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private listeners = new Set<StageListener>();
  private raf = 0;
  private last = 0;
  private resting = true;
  private direction: 1 | -1 = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private latest: StageFrame | null = null;

  constructor(story: Story) {
    this.story = story;
  }

  /** The frame state most recently rendered. */
  get frame(): StageFrame | null {
    return this.latest;
  }

  setStory(story: Story) {
    if (story === this.story) return;
    this.story = story;
    this.wake();
  }

  subscribe(listener: StageListener): () => void {
    this.listeners.add(listener);
    this.wake();
    return () => {
      this.listeners.delete(listener);
    };
  }

  stats(): StageStats {
    return {
      store: this.store?.stats() ?? null,
      chapter: this.store && this.latest ? this.store.chapterStats(this.latest.chapter) : null,
      compositor: this.compositor?.stats() ?? null,
    };
  }

  /** Make sure a frame is rendered soon (scroll, resize, a frame arrived, a listener joined). */
  wake = () => {
    if (this.raf || !this.canvas) return;
    if (this.resting) {
      // Time the first step from now, not from when the loop last stopped.
      this.last = performance.now();
      this.resting = false;
    }
    this.raf = requestAnimationFrame(this.render);
  };

  /** Start drawing on the canvas. Returns the function that stops it again. */
  attach(canvas: HTMLCanvasElement): () => void {
    this.canvas = canvas;
    this.params = readStageParams(window.location.search);
    this.clock.frozen = this.params.p;

    const store = new FrameStore(this.wake);
    if (this.params.memMb) store.setCap(this.params.memMb * MB);
    this.store = store;
    this.compositor = createCompositor(canvas, this.wake);
    if (this.params.hud) window.homewardStage = this;

    const cleanups: (() => void)[] = [];
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(type, fn, opts);
      cleanups.push(() => window.removeEventListener(type, fn, opts));
    };

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => {
      this.clock.reducedMotion = motion.matches;
      this.wake();
    };
    onMotion();
    motion.addEventListener("change", onMotion);
    cleanups.push(() => motion.removeEventListener("change", onMotion));

    const onResize = () => {
      this.measure();
      this.wake();
    };
    on("scroll", this.wake, { passive: true });
    on("resize", onResize);
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(onResize);
      observer.observe(canvas);
      cleanups.push(() => observer.disconnect());
    }
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    if (connection && typeof connection.addEventListener === "function") {
      connection.addEventListener("change", onResize);
      cleanups.push(() => connection.removeEventListener("change", onResize));
    }

    if (process.env.NODE_ENV !== "production") {
      // Frames imported while the page is open appear when you come back to the tab.
      const recheck = () => {
        if (document.visibilityState === "visible") store.recheckManifests();
      };
      on("focus", recheck);
      document.addEventListener("visibilitychange", recheck);
      cleanups.push(() => document.removeEventListener("visibilitychange", recheck));
    }

    this.measure();
    this.clock.setTarget(this.readScroll());
    this.clock.snap();
    store.start();
    this.wake();

    return () => {
      for (const fn of cleanups) fn();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.resting = true;
      store.dispose();
      this.compositor?.dispose();
      this.compositor = null;
      this.store = null;
      this.canvas = null;
      if (window.homewardStage === this) delete window.homewardStage;
    };
  }

  private measure() {
    const canvas = this.canvas;
    const store = this.store;
    if (!canvas || !store) return;
    this.cssWidth = canvas.clientWidth || window.innerWidth;
    this.cssHeight = canvas.clientHeight || window.innerHeight;
    const { tier, reason } = chooseTier(this.cssWidth, store.capBytes, this.params.tier);
    store.setTier(tier, reason);
  }

  /** Raw progress of the window's scroll position over the whole page, 0..1. */
  private readScroll(): number {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? window.scrollY / max : 0;
  }

  private layer(frame: Frame): Layer {
    const chapter = this.story.chapters.find((c) => c.clip === frame.clip);
    const focal: Point = chapter ? focalFor(chapter, this.cssWidth, this.cssHeight) : tune.defaultFocal;
    return { key: frame.key, image: frame.image, width: frame.width, height: frame.height, focal };
  }

  private render = (now: number) => {
    this.raf = 0;
    const canvas = this.canvas;
    const store = this.store;
    if (!canvas || !store) return;

    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;

    // 1. The clock.
    if (this.clock.frozen === null) this.clock.setTarget(this.readScroll());
    let more = this.clock.tick(dt);
    const { p, velocity } = this.clock;
    if (velocity > 0) this.direction = 1;
    else if (velocity < 0) this.direction = -1;

    // 2. The canvas size, at a capped device pixel ratio.
    const phone = isPhoneViewport(this.cssWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, phone ? tune.dprCapPhone : tune.dprCapDesktop);
    this.compositor?.resize(Math.max(1, Math.round(this.cssWidth * dpr)), Math.max(1, Math.round(this.cssHeight * dpr)));

    // 3. Loads, then the frames to draw: the wanted pair, else the nearest loaded frame, else
    //    whatever the compositor drew last. Never a blank frame.
    const story = this.story;
    store.update(p, this.direction, story);
    const chapter = chapterAt(p, story);
    const count = store.countFor(chapter);
    const t = localT(p, story);
    const shown = store.pick(p, story);
    if (this.compositor) {
      const usable = shown && store.holds(shown.a) && store.holds(shown.b);
      const scene = usable ? { a: this.layer(shown.a), b: this.layer(shown.b), mix: shown.mix } : null;
      if (this.compositor.draw(scene) && !canvas.hasAttribute("data-ready")) canvas.setAttribute("data-ready", "");
    }

    // 4. Everyone else reads the same state.
    const state: StageFrame = {
      now,
      dt,
      p,
      target: this.clock.target,
      velocity,
      direction: this.direction,
      story,
      chapter,
      t,
      count,
      frame: t * (count - 1),
      shown,
      reducedMotion: this.clock.reducedMotion,
      frozen: this.clock.frozen !== null,
      width: this.cssWidth,
      height: this.cssHeight,
      dpr,
      phone,
    };
    this.latest = state;
    for (const listener of this.listeners) {
      try {
        if (listener(state) === true) more = true;
      } catch (error) {
        console.error("Homeward: a stage listener failed.", error);
      }
    }

    if (more) this.raf = requestAnimationFrame(this.render);
    else this.resting = true;
  };
}
