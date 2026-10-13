import {
  chapterAt,
  joinAt,
  joinWindow,
  localT,
  localTOf,
  tune,
  type JoinWindow,
  type OverlayName,
  type Point,
  type Story,
  type StoryChapter,
  type Tier,
} from "@/content/story";
import { ScrollClock } from "./clock";
import { createCompositor, type Compositor, type CompositorStats, type Layer, type OverlayScene, type Picture, type Scene } from "./compositor";
import { focalFor, isPhoneViewport } from "./fit";
import { chooseTier, FrameStore, MB, type Frame, type FramePick, type StoreStats } from "./frameStore";
import { joinSpeed, type JoinKind } from "./joins";
import { breathCalm, overlaysAt, pictureLook, type LookEnv, type OverlayState } from "./looks";
import { createOverlay, type Overlay } from "./overlay";
import { PageFlip } from "./pageFlip";

/**
 * The stage engine: one requestAnimationFrame loop that reads the scroll into the clock, plans
 * the frame store's loads around the smoothed progress p, has the compositor draw, and then hands
 * the same frame state to every listener (the HUD now; captions, sound and chrome later). The
 * loop only runs while something moves: the clock settling, a frame arriving, or a listener asking
 * for another frame. At rest it stops.
 *
 * Inside a join window (story.ts joinAt) it picks the frames of both chapters, the outgoing one
 * holding its last frame past the boundary and the incoming one its first before it, and hands the
 * compositor the join with its time t and the scroll speed. Under reduced motion every join is the
 * plain cross-dissolve.
 *
 * Each picture also gets its chapter's look (looks.ts: zoom, drift, breath, vignette) and the scene
 * its overlays (the mist and dust videos, a screen blend, and the paper texture, a soft-light blend, over
 * everything). Both follow p, and the breath the
 * clock as well; the chapters with page flips (c07) show a smoothed, capped frame index (pageFlip.ts) and the loop
 * keeps running until it has caught up. The loop keeps running only while the breath moves or an overlay video needs
 * frames pulled, and never under reduced motion.
 *
 * URL parameters (development aids):
 *   ?hud=1                  the dev HUD (and window.homewardStage)
 *   ?p=0.42                 freeze progress at 0.42 (the scroll is ignored)
 *   ?join=c01-follow&t=0.5  freeze inside the join out of that chapter, at join time t (default 0.5);
 *                           t=0 and t=1 show the plain frames either side of the window
 *   ?v=120                  while frozen, pretend the page scrolls at 120 vh per second (the smear
 *                           and edge terms follow the speed, so a still hold would not show them)
 *   ?clock=1500             hold the ambient clock at 1500 ms: the breath stands at that time and the overlay
 *                           video is paused at that time of its loop, so screenshots and hashes repeat exactly
 *   ?tier=768               force a frame tier
 *   ?mem=80                 frame memory cap in MB (default tune.memoryCapMb)
 */

export interface StageParams {
  hud: boolean;
  p: number | null;
  /** Chapter id whose join to hold, and the join time to hold it at. */
  join: string | null;
  t: number | null;
  /** Pretended scroll speed while frozen, in vh per second. */
  v: number | null;
  /** Ambient clock held at this many ms (breath and overlay video), or null to follow real time. */
  clock: number | null;
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
  const t = num("t");
  const v = num("v");
  const clock = num("clock");
  const tier = num("tier");
  const mem = num("mem");
  const join = q.get("join");
  return {
    hud: q.get("hud") === "1" || q.get("hud") === "true",
    p: p === null ? null : Math.min(1, Math.max(0, p)),
    join: join && join.trim() !== "" ? join.trim() : null,
    t: t === null ? null : Math.min(1, Math.max(0, t)),
    v,
    clock: clock === null ? null : Math.max(0, clock),
    tier: tier !== null && (tune.tiers as readonly number[]).includes(tier) ? (tier as Tier) : null,
    memMb: mem !== null && mem > 0 ? mem : null,
  };
}

/** A join in progress at p. */
export interface StageJoin {
  /** What is drawn: the story's join type, or "dissolve" under reduced motion. */
  kind: JoinKind;
  window: JoinWindow;
  /** Join time, 0..1 across the window. */
  t: number;
  /** Absolute scroll speed, 0..1 against tune.joins.speedRefVh. */
  speed: number;
  /** The outgoing and incoming chapters' frames (null while nothing of them is loaded). */
  out: FramePick | null;
  into: FramePick | null;
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
  /** The frames of the chapter playing (null when none is loaded yet). */
  shown: FramePick | null;
  /** The join in progress, if p is inside a join window. */
  join: StageJoin | null;
  /** The overlays showing at p (their opacities); whether their files exist is separate. */
  overlays: OverlayState[];
  /** Displayed frame index of the current chapter when it has page flips (smoothed and capped), else null. */
  flip: number | null;
  /** Breath strength, 1 at rest to 0 while scrolling fast. */
  calm: number;
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
  params: StageParams = { hud: false, p: null, join: null, t: null, v: null, clock: null, tier: null, memMb: null };

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
  private overlays: Partial<Record<OverlayName, Overlay>> = {};
  /** Page-flip chasers by chapter id, and the local time each one displays this frame. */
  private flips = new Map<string, PageFlip>();
  private flipAt = new Map<string, number>();
  /** Set while building the pictures of one frame: a breath is moving. */
  private breathing = false;
  private look: LookEnv = { width: 0, height: 0, reducedMotion: false, now: 0, calm: 1 };
  private p = 0;

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
    this.hold();
    this.wake();
  }

  /** The progress ?p= or ?join=&t= freeze the clock at, for this story (null: follow the scroll). */
  private hold() {
    const { join, t, p } = this.params;
    let frozen = p;
    if (join) {
      const w = joinWindow(join, this.story);
      if (w) frozen = w.startP + (t ?? 0.5) * (w.endP - w.startP);
      else console.warn(`Homeward: ?join=${join} names no chapter with a join in this story.`);
    }
    this.clock.frozen = frozen;
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
    this.hold();

    const store = new FrameStore(this.wake);
    if (this.params.memMb) store.setCap(this.params.memMb * MB);
    this.store = store;
    this.compositor = createCompositor(canvas, this.wake);
    this.overlays = Object.fromEntries((Object.keys(tune.overlays) as OverlayName[]).map((name) => [name, createOverlay(name, this.wake)]));
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
        if (document.visibilityState !== "visible") return;
        store.recheckManifests();
        for (const overlay of Object.values(this.overlays)) overlay?.retry();
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
      for (const overlay of Object.values(this.overlays)) overlay?.dispose();
      this.overlays = {};
      this.flips.clear();
      this.flipAt.clear();
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

  /** A pick as a compositor picture with its chapter's look, if the store still holds both of its frames. */
  private picture(pick: FramePick | null): Picture | null {
    const store = this.store;
    if (!pick || !store || !store.holds(pick.a) || !store.holds(pick.b)) return null;
    const a = this.layer(pick.a);
    const chapter = this.story.chapters.find((c) => c.clip === pick.a.clip);
    const look = chapter ? pictureLook(chapter, localTOf(chapter, this.p, this.story), this.look, a) : null;
    if (look?.breathing) this.breathing = true;
    return { a, b: this.layer(pick.b), mix: pick.mix, look };
  }

  /** Keep the overlays in step with p: fetched when the story is near, videos playing while visible. */
  private overlayScene(states: OverlayState[], chapterIndex: number): OverlayScene[] {
    const scene: OverlayScene[] = [];
    for (const [name, overlay] of Object.entries(this.overlays) as [OverlayName, Overlay][]) {
      const group = this.story.chapters.filter((c) => c.overlays?.includes(name));
      const near =
        !this.clock.reducedMotion &&
        group.length > 0 &&
        chapterIndex >= group[0].index - 1 &&
        chapterIndex <= group[group.length - 1].index + 1;
      if (near) overlay.load();
      const state = states.find((o) => o.name === name);
      const visible = !!state && state.opacity > 0;
      if (this.params.clock !== null) overlay.hold(visible ? this.params.clock / 1000 : null);
      else overlay.setPlaying(visible);
      const source = visible ? overlay.source() : null;
      if (visible && overlay.polling) this.breathing = true; // no frame callbacks: pull a frame every tick
      if (source && state) scene.push({ name, source, opacity: state.opacity });
    }
    return scene;
  }

  /**
   * The page flips of this render: for each chapter with pageFlip, the displayed local time, which
   * chases the scroll's (pageFlip.ts) while the chapter is playing or joining and sits on it otherwise.
   */
  private stepFlips(store: FrameStore, p: number, dt: number, current: StoryChapter, joining: JoinWindow | null): boolean {
    let chasing = false;
    this.flipAt.clear();
    for (const c of this.story.chapters) {
      if (!c.pageFlip) continue;
      let flip = this.flips.get(c.id);
      if (!flip) this.flips.set(c.id, (flip = new PageFlip()));
      const count = store.countFor(c);
      const target = localTOf(c, p, this.story) * (count - 1);
      const follow = c === current || joining?.from === c || joining?.to === c;
      const shown = flip.step(target, count, p, dt, follow, this.clock.reducedMotion);
      this.flipAt.set(c.id, count > 1 ? shown / (count - 1) : 0);
      if (flip.chasing(target)) chasing = true;
    }
    return chasing;
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
    const { p } = this.clock;
    const story = this.story;
    // A frozen hold has no velocity; ?v= pretends one, so the speed terms of a join can be seen.
    const velocity = this.clock.frozen !== null && this.params.v !== null ? this.params.v / story.totalVh : this.clock.velocity;
    if (velocity > 0) this.direction = 1;
    else if (velocity < 0) this.direction = -1;

    // 2. The canvas size, at a capped device pixel ratio.
    const phone = isPhoneViewport(this.cssWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, phone ? tune.dprCapPhone : tune.dprCapDesktop);
    this.compositor?.resize(Math.max(1, Math.round(this.cssWidth * dpr)), Math.max(1, Math.round(this.cssHeight * dpr)));

    // 3. Loads, then the frames to draw: the wanted pair, else the nearest loaded frame, else
    //    whatever the compositor drew last. Never a blank frame. Inside a join window, both
    //    chapters' frames and the join itself; if one side has nothing loaded, the plain frame.
    store.update(p, this.direction, story);
    const chapter = chapterAt(p, story);
    this.p = p;
    this.breathing = false;
    const calm = breathCalm(velocity, story.totalVh);
    this.look = { width: this.cssWidth, height: this.cssHeight, reducedMotion: this.clock.reducedMotion, now: this.params.clock ?? now, calm };
    const count = store.countFor(chapter);
    const t = localT(p, story);
    const active = joinAt(p, story);
    if (this.stepFlips(store, p, dt, chapter, active?.window ?? null)) more = true;
    const shown = store.pickChapter(chapter, p, story, this.flipAt.get(chapter.id));
    let join: StageJoin | null = null;
    let scene: Scene | null = this.picture(shown);
    if (active) {
      const { window: w } = active;
      const out = store.pickChapter(w.from, p, story, this.flipAt.get(w.from.id));
      const into = store.pickChapter(w.to, p, story, this.flipAt.get(w.to.id));
      const kind: JoinKind = this.clock.reducedMotion ? "dissolve" : w.type;
      const speed = joinSpeed(velocity, story.totalVh);
      join = { kind, window: w, t: active.t, speed, out, into };
      const outPicture = this.picture(out);
      const intoPicture = this.picture(into);
      if (outPicture && intoPicture) {
        scene = {
          ...outPicture,
          join: { kind, t: active.t, speed, px: dpr, into: intoPicture, pupil: w.from.anchors.pupil, photoRect: w.from.anchors.photoRect },
        };
      }
    }
    const overlays = overlaysAt(p, story, this.clock.reducedMotion);
    const overlayScene = this.overlayScene(overlays, chapter.index);
    if (scene) scene = { ...scene, overlays: overlayScene };
    if (this.compositor) {
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
      join,
      overlays,
      flip: chapter.pageFlip && this.flipAt.has(chapter.id) ? this.flipAt.get(chapter.id)! * (count - 1) : null,
      calm,
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

    if (this.breathing) more = true;
    if (more) this.raf = requestAnimationFrame(this.render);
    else this.resting = true;
  };
}
