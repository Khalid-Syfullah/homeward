import {
  joinWindow,
  palette,
  tune,
  type Look,
  type OverlayName,
  type Point,
  type Story,
  type StoryChapter,
  type VignetteState,
} from "@/content/story";
import { coverFit, frameToScreen } from "./fit";

/**
 * Per-chapter looks, as pure math. The compositor reads the numbers; nothing here draws.
 *
 *   zoom, drift   the picture is read at  s' = centre + (s - centre) / k + (0, shift),  the same
 *                 radial form the joins use (the term 1/k - 1 is exactly zero when k = 1, so a look at
 *                 rest is the plain frame to the bit). The drift is clamped so the read never leaves
 *                 the frame: a viewport with no spare crop never shows an edge.
 *   breath        k grows by 1 + amplitude * (1 - cos(2 pi time / period)) / 2 on the clock, and the
 *                 amplitude is scaled by "calm", which falls to zero as the scroll speeds up.
 *   vignette      a colour that closes in from the outer radius, toward the chapter's centre or its
 *                 pupil anchor.
 *   overlays      the opacity of each overlay (mist, dust, paper) as a function of p: linear across the
 *                 chapters that share it, eased in over the join into the first and out over the join
 *                 after the last.
 *
 * A look is a function of the chapter's local time t and, for the breath only, of the clock time and
 * the scroll speed. Under reduced motion nothing moves: no zoom, drift or breath, and the vignette
 * holds the state at the middle of the chapter.
 */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const smoothBetween = (lo: number, hi: number, v: number) => (hi > lo ? smooth((v - lo) / (hi - lo)) : v >= hi ? 1 : 0);

/** The vignette as the compositor wants it: centre on screen (0..1), radii in viewport heights. */
export interface VignetteLook {
  centre: Point;
  inner: number;
  outer: number;
  strength: number;
  color: [number, number, number];
}

export interface PictureLook {
  /** The zoom centre on screen, 0..1. */
  centre: Point;
  /** 1 / zoom - 1 (zero or less). */
  term: number;
  /** Vertical shift of the read, as a share of the viewport height. */
  shiftY: number;
  vignette: VignetteLook | null;
  /** True while the breath is moving (the render loop must keep going). */
  breathing: boolean;
}

export interface LookEnv {
  /** Viewport in CSS pixels. */
  width: number;
  height: number;
  reducedMotion: boolean;
  /** The clock, in ms. */
  now: number;
  /** 1 at rest, 0 while scrolling fast (breathCalm). */
  calm: number;
}

/** What a look needs to know about the chapter's frame. */
export interface LookFrame {
  width: number;
  height: number;
  focal: Point;
}

/** Breath strength from the scroll speed: 1 at rest, 0 from tune.look.breathStillVh. */
export function breathCalm(velocity: number, totalVh: number): number {
  if (!Number.isFinite(velocity) || totalVh <= 0) return 1;
  const speed = Math.abs(velocity) * totalVh;
  return 1 - smoothBetween(tune.look.breathCalmVh, tune.look.breathStillVh, speed);
}

/** The breath wave at a clock time, 0..1 (a sine, starting at zero). */
export function breathWave(nowMs: number, periodS: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * nowMs) / (periodS * 1000));
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function mixState(a: VignetteState, b: VignetteState, t: number): VignetteState {
  return { strength: lerp(a.strength, b.strength, t), inner: lerp(a.inner, b.inner, t), outer: lerp(a.outer, b.outer, t) };
}

/** The look of a chapter at local time t, or null when it has none (or nothing of it is showing). */
export function pictureLook(chapter: Pick<StoryChapter, "look" | "anchors">, t: number, env: LookEnv, frame: LookFrame): PictureLook | null {
  const look: Look | undefined = chapter.look;
  if (!look) return null;
  const moving = !env.reducedMotion;
  const time = clamp01(t);

  // Where the zoom and the vignette are centred: the middle of the screen or the pupil anchor.
  const pupil = chapter.anchors.pupil ?? tune.defaultPupil;
  const pupilOnScreen = (): Point => frameToScreen(pupil, coverFit(env.width, env.height, frame.width, frame.height, frame.focal));
  const middle: Point = { x: 0.5, y: 0.5 };
  const centre = look.zoomAbout === "pupil" ? pupilOnScreen() : middle;

  let k = 1;
  let breathing = false;
  if (moving && look.scale) k *= lerp(look.scale.from, look.scale.to, time);
  if (moving && look.breath && env.calm > 0) {
    k *= 1 + look.breath.amplitude * env.calm * breathWave(env.now, look.breath.periodS);
    breathing = true;
  }
  const term = k === 1 ? 0 : 1 / k - 1;

  // Drift in CSS pixels to a share of the height, kept inside the margin the zoom leaves.
  let shiftY = 0;
  if (moving && look.driftPx && env.height > 0) {
    const wanted = -lerp(look.driftPx.from, look.driftPx.to, time) / env.height;
    const room = 1 - 1 / k;
    shiftY = Math.min(Math.max(wanted, -centre.y * room), (1 - centre.y) * room);
  }

  let vignette: VignetteLook | null = null;
  if (look.vignette) {
    const v = look.vignette;
    const state = mixState(v.from, v.to, moving ? smooth(time) : 0.5);
    if (state.strength > 0) {
      vignette = {
        centre: v.toward === "pupil" ? pupilOnScreen() : middle,
        inner: state.inner,
        outer: Math.max(state.outer, state.inner + 1e-3),
        strength: state.strength,
        color: hexRgb(palette[v.color]),
      };
    }
  }

  if (term === 0 && shiftY === 0 && !vignette && !breathing) return null;
  return { centre, term, shiftY, vignette, breathing };
}

// ---------- overlays ----------

export interface OverlayState {
  name: OverlayName;
  /** 0..1; the overlay is drawn only above zero. */
  opacity: number;
}

/**
 * The overlays showing at p. The chapters of the story that share an overlay form one group; the
 * opacity runs linearly from tune.overlays[name].from at the start of the first to .to at the end
 * of the last (in scroll), eased in over the join window into the first chapter and out over the join
 * window after the last one (or, when the group runs to the end of the film, nothing after). Zero
 * everywhere else, exactly, so an overlay never pops on or off; two overlays can show at once (dust
 * and paper over the book). Under reduced motion there are no overlays.
 */
export function overlaysAt(p: number, story: Story, reducedMotion = false): OverlayState[] {
  if (reducedMotion) return [];
  const names: OverlayName[] = [];
  for (const c of story.chapters) for (const name of c.overlays ?? []) if (!names.includes(name)) names.push(name);
  const shown: OverlayState[] = [];
  for (const name of names) {
    const group = story.chapters.filter((c) => c.overlays?.includes(name));
    const first = group[0];
    const last = group[group.length - 1];
    const spec = tune.overlays[name];
    const vh = clamp01(p) * story.totalVh;
    const span = last.endVh - first.startVh;
    let opacity = lerp(spec.from, spec.to, span > 0 ? clamp01((vh - first.startVh) / span) : 0);

    // Eased in over the join into the first chapter, and out over the join after the last.
    const before = first.index > 0 ? joinWindow(story.chapters[first.index - 1], story) : null;
    if (before) {
      if (p <= before.startP) continue;
      opacity *= smoothBetween(before.startP, before.endP, p);
    } else if (vh < first.startVh) {
      continue;
    }
    const after = joinWindow(last, story);
    if (after) {
      if (p >= after.endP) continue;
      opacity *= 1 - smoothBetween(after.startP, after.endP, p);
    } else if (vh > last.endVh) {
      continue;
    }
    // Inside the chapters the window terms are 1; between the window and the chapter they hold.
    if (opacity > 0) shown.push({ name, opacity });
  }
  return shown;
}
