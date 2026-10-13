import { tune, type Point, type Rect } from "@/content/story";
import { coverFit, frameToScreen, type Fit } from "./fit";

/**
 * The three joins, as pure math. A join is a short transition across a chapter boundary, a pure
 * function of its time t (0..1 over the window story.ts gives it) and of the absolute scroll speed.
 * This file turns t, the speed, the view and the two frames' cover fits into the few numbers the
 * compositor's shaders (and the 2D fallback, and the HUD) need. It draws nothing itself.
 *
 * Every join is the outgoing picture exactly at t = 0 and the incoming one exactly at t = 1, so it
 * can never pop against the frames either side of its window. That is arranged in the arithmetic,
 * not by a tolerance: zooms travel as the radial term 1/k - 1 (exactly 0 when k = 1), the rect's
 * maps as affine s * A + B with A = w/w = 1 and B = x - x = 0 at t = 0, and the incoming frame's
 * fit at t = 1 is the very same cover fit the plain path uses. The velocity terms (smear, feather,
 * bite) are multiplied by a bump that is zero at both ends of the window.
 *
 *   push    a cross-dissolve with a zoom push (outgoing 1.00 to 1.06, incoming 1.06 to 1.00) and a
 *           radial smear that grows with the speed;
 *   portal  a circle that opens from the pupil anchor, placed with the frame's own cover fit so it
 *           holds at any viewport, from radius 0 to the screen diagonal, with a feathered,
 *           noise-bitten edge and a faint dark ring at the rim; the incoming frame settles from
 *           1.25 to 1.00 inside it;
 *   rect    the photograph (the photoRect anchor) grows from where it sits on screen until it
 *           fills the viewport, with a soft edge, the whole outgoing frame zooming with it so its
 *           paper border slides off; the incoming frame is fitted into the rectangle, so it is
 *           matched in scale at t = 0, and dissolves in over the photograph's own picture;
 *   dissolve the plain cross-dissolve used for all three under reduced motion.
 */

export type JoinKind = "push" | "portal" | "rect" | "dissolve";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;

/** The join's easing: smoothstep, exactly 0 at 0 and 1 at 1 and flat at both, so nothing kinks. */
export function ease(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** The shape of the velocity terms: exactly 0 at t = 0 and t = 1, 1 at the middle. */
export function bump(t: number): number {
  const x = clamp01(t);
  return 4 * x * (1 - x);
}

/** The scroll velocity (p per second) as a 0..1 speed against tune.joins.speedRefVh. */
export function joinSpeed(velocity: number, totalVh: number): number {
  if (!Number.isFinite(velocity) || totalVh <= 0) return 0;
  return clamp01((Math.abs(velocity) * totalVh) / tune.joins.speedRefVh);
}

/** What a join needs to know about one of its two frames. */
export interface JoinFrame {
  width: number;
  height: number;
  /** Focal point in 0..1 frame coordinates (fit.ts). */
  focal: Point;
}

export interface JoinInput {
  kind: JoinKind;
  /** Join time, 0..1 across the window. */
  t: number;
  /** Absolute scroll speed, 0..1 (joinSpeed). */
  speed: number;
  /** The view in pixels: device pixels in the compositor, CSS pixels in the HUD... */
  width: number;
  height: number;
  /** ...and the size of one CSS pixel in those units (the device pixel ratio, or 1). */
  px: number;
  /** The outgoing frame (the chapter ending) and the incoming one (the chapter starting). */
  out: JoinFrame;
  into: JoinFrame;
  /** Anchors in 0..1 coordinates of the outgoing frame; the tune defaults stand in when missing. */
  pupil?: Point;
  photoRect?: Rect;
}

export interface DissolveGeometry {
  kind: "dissolve";
  /** 0 shows the outgoing picture, 1 the incoming one. */
  mix: number;
}

export interface PushGeometry {
  kind: "push";
  mix: number;
  /** The zooms as radial terms 1/k - 1: screen' = screen + (screen - centre) * term. Both 0 means no zoom. */
  zoomOut: number;
  zoomIn: number;
  /** The scales themselves, for the HUD. */
  scaleOut: number;
  scaleIn: number;
  /** Zoom centre in 0..1 screen coordinates. */
  centre: Point;
  /** Radial smear reach as a share of the distance from the centre; 0 means a single tap. */
  smear: number;
}

export interface PortalGeometry {
  kind: "portal";
  /** Circle centre in pixels (y down) and in 0..1 screen coordinates. */
  centre: Point;
  centreN: Point;
  /** The edge of the circle, in pixels (the incoming picture is fully through inside radius - feather). */
  radius: number;
  /** The radius at t = 1: the screen diagonal, or more if the centre sits near a corner. */
  reach: number;
  /** The incoming frame's zoom about the centre as the radial term 1/k - 1, and the scale itself. */
  zoomIn: number;
  scaleIn: number;
  /** Feather width, noise bite amplitude, ring width, all in pixels, and the ring strength. */
  feather: number;
  bite: number;
  ring: number;
  ringStrength: number;
  /** Noise cells around the circle and the length of one cell outward, in pixels. */
  cells: number;
  biteLength: number;
  /**
   * Half-width of the rim band in pixels: a pixel farther than radius + band from the centre is
   * provably the outgoing picture, one nearer than radius - band provably the incoming one.
   */
  band: number;
}

export interface RectGeometry {
  kind: "rect";
  /** The growing photograph on screen, in pixels (y down). */
  rect: Rect;
  /** The outgoing frame's screen map, screen' = screen * scale + offset (0..1 screen coordinates). */
  outMap: { scaleX: number; scaleY: number; offsetX: number; offsetY: number };
  /** The incoming frame's fit, screen (0..1) to frame uv, already composed with the rectangle. */
  inFit: Fit;
  /** Soft edge width outside the rectangle, in pixels. */
  feather: number;
  /** How far the photograph's own picture has dissolved into the live frame inside the rectangle. */
  dissolve: number;
}

export type JoinGeometry = DissolveGeometry | PushGeometry | PortalGeometry | RectGeometry;

/** The photoRect anchor (0..1 frame coordinates) on screen (0..1 screen coordinates), through the fit. */
export function rectOnScreen(rect: Rect, fit: Fit): Rect {
  const corner = frameToScreen({ x: rect.x, y: rect.y }, fit);
  return { x: corner.x, y: corner.y, w: rect.w / fit.scaleX, h: rect.h / fit.scaleY };
}

/** Where a frame is drawn (0..1 screen coordinates) when `fit` cover-fits it into `into`. */
function drawnRect(fit: Fit, into: Rect): Rect {
  const w = into.w / fit.scaleX;
  const h = into.h / fit.scaleY;
  return { x: into.x - fit.offsetX * w, y: into.y - fit.offsetY * h, w, h };
}

/** The join's numbers at time t. Pure: the same input always gives the same geometry. */
export function joinGeometry(input: JoinInput): JoinGeometry {
  const { width, height, px } = input;
  const t = clamp01(input.t);
  const speed = clamp01(input.speed);
  const e = ease(t);
  const fitOut = coverFit(width, height, input.out.width, input.out.height, input.out.focal);

  switch (input.kind) {
    case "dissolve":
      return { kind: "dissolve", mix: e };

    case "push": {
      const { zoom, smear } = tune.joins.push;
      const scaleOut = 1 + zoom * e;
      const scaleIn = 1 + zoom * (1 - e);
      return {
        kind: "push",
        mix: e,
        zoomOut: 1 / scaleOut - 1,
        zoomIn: 1 / scaleIn - 1,
        scaleOut,
        scaleIn,
        centre: { x: 0.5, y: 0.5 },
        smear: smear * speed * bump(t),
      };
    }

    case "portal": {
      const k = tune.joins.portal;
      const pupil = input.pupil ?? tune.defaultPupil;
      const centreN = frameToScreen(pupil, fitOut);
      const centre = { x: centreN.x * width, y: centreN.y * height };
      // The widest the rim band can get, so the circle provably covers every pixel at t = 1 even
      // when the centre sits by a corner, and so the band terms open up at the same rate at any speed.
      const bandMax = (k.bite + k.biteSpeed + Math.max(k.feather + k.featherSpeed, k.ring)) * px;
      const diagonal = Math.hypot(width, height);
      const corner = Math.hypot(Math.max(centre.x, width - centre.x), Math.max(centre.y, height - centre.y));
      const reach = Math.max(diagonal, corner + bandMax + px);
      const radius = e * reach;
      // The band terms grow with the circle (a pinprick has no feather), so all of them are
      // exactly zero at t = 0 and the fast paths cover the whole screen there.
      const open = bandMax > 0 ? clamp01(radius / bandMax) : 1;
      const feather = (k.feather + k.featherSpeed * speed) * px * open;
      const bite = (k.bite + k.biteSpeed * speed) * px * open;
      const ring = k.ring * px * open;
      const scaleIn = 1 + k.zoom * (1 - e);
      return {
        kind: "portal",
        centre,
        centreN,
        radius,
        reach,
        zoomIn: 1 / scaleIn - 1,
        scaleIn,
        feather,
        bite,
        ring,
        ringStrength: k.ringStrength * open,
        cells: k.biteCells,
        biteLength: k.biteLength * px,
        band: bite + Math.max(feather, ring),
      };
    }

    case "rect": {
      const k = tune.joins.rect;
      const photo = rectOnScreen(input.photoRect ?? tune.defaultPhotoRect, fitOut);
      // The incoming frame is drawn (in 0..1 screen coordinates) over d0 at t = 0, its cover fit
      // inside the photograph, and over d1 at t = 1, its plain cover fit of the screen; in between
      // over the lerp of the two, which has the frame's aspect, so it is one uniform zoom. The
      // outgoing frame follows the very same map, so the photograph's own picture stays registered
      // with the live one through the dissolve and its paper border slides off with the zoom.
      const fitP = coverFit(photo.w * width, photo.h * height, input.into.width, input.into.height, input.into.focal);
      const fitV = coverFit(width, height, input.into.width, input.into.height, input.into.focal);
      const d0 = drawnRect(fitP, photo);
      const d1 = drawnRect(fitV, { x: 0, y: 0, w: 1, h: 1 });
      const d: Rect = { x: lerp(d0.x, d1.x, e), y: lerp(d0.y, d1.y, e), w: lerp(d0.w, d1.w, e), h: lerp(d0.h, d1.h, e) };
      // Outgoing: screen' = screen * a + b takes d back to d0 (exactly 1 and 0 at t = 0).
      const ax = d0.w / d.w;
      const ay = d0.h / d.h;
      const bx = d0.x - d.x * ax;
      const by = d0.y - d.y * ay;
      // Incoming: screen to the t = 1 screen (exactly 1 and 0 at t = 1), then the plain fit.
      const cx = d1.w / d.w;
      const cy = d1.h / d.h;
      const ex = d1.x - d.x * cx;
      const ey = d1.y - d.y * cy;
      // The visible window: the photograph's border where the zoom has carried it, widened toward
      // the screen so it is the photograph at t = 0 and covers the whole screen at t = 1.
      const border: Rect = { x: (photo.x - bx) / ax, y: (photo.y - by) / ay, w: photo.w / ax, h: photo.h / ay };
      const left = Math.min(border.x, lerp(photo.x, 0, e));
      const top = Math.min(border.y, lerp(photo.y, 0, e));
      const right = Math.max(border.x + border.w, lerp(photo.x + photo.w, 1, e));
      const bottom = Math.max(border.y + border.h, lerp(photo.y + photo.h, 1, e));
      return {
        kind: "rect",
        rect: { x: left * width, y: top * height, w: (right - left) * width, h: (bottom - top) * height },
        outMap: { scaleX: ax, scaleY: ay, offsetX: bx, offsetY: by },
        inFit: { scaleX: cx * fitV.scaleX, scaleY: cy * fitV.scaleY, offsetX: ex * fitV.scaleX + fitV.offsetX, offsetY: ey * fitV.scaleY + fitV.offsetY },
        feather: (k.feather + k.featherSpeed * speed) * px,
        dissolve: k.dissolveEnd > 0 ? ease(t / k.dissolveEnd) : 1,
      };
    }
  }
}
