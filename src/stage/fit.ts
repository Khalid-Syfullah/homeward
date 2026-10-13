import { tune, type Chapter, type Point } from "@/content/story";

/**
 * Cover-fit with a focal point: the frame is scaled to cover the viewport and then slid so its
 * focal point sits as close to the centre as the crop allows (it never uncovers an edge). On a
 * 16:9 desktop the whole frame shows; on a phone the crop keeps the subject.
 *
 * A Fit maps viewport coordinates to frame coordinates, both 0..1 with y down:
 *   frame = screen * scale + offset
 * The compositor uses the same numbers (in its vertex shader), and so must anything that places
 * an anchor (the pupil, the photograph) on screen, so it holds at any viewport.
 */
export interface Fit {
  /** Share of the frame's width and height the viewport shows (1 or less). */
  scaleX: number;
  scaleY: number;
  /** Frame coordinate at the viewport's top-left corner. */
  offsetX: number;
  offsetY: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function coverFit(viewW: number, viewH: number, frameW: number, frameH: number, focal: Point): Fit {
  if (viewW <= 0 || viewH <= 0 || frameW <= 0 || frameH <= 0) {
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.max(viewW / frameW, viewH / frameH);
  const drawnW = frameW * scale;
  const drawnH = frameH * scale;
  // Top-left of the drawn frame in viewport pixels, focal point centred, edges never uncovered.
  const left = clamp(viewW / 2 - focal.x * drawnW, viewW - drawnW, 0);
  const top = clamp(viewH / 2 - focal.y * drawnH, viewH - drawnH, 0);
  return { scaleX: viewW / drawnW, scaleY: viewH / drawnH, offsetX: -left / drawnW, offsetY: -top / drawnH };
}

/** A point in frame coordinates (0..1) to viewport coordinates (0..1; outside when cropped away). */
export function frameToScreen(point: Point, fit: Fit): Point {
  return { x: (point.x - fit.offsetX) / fit.scaleX, y: (point.y - fit.offsetY) / fit.scaleY };
}

/** A point in viewport coordinates (0..1) to frame coordinates (0..1). */
export function screenToFrame(point: Point, fit: Fit): Point {
  return { x: point.x * fit.scaleX + fit.offsetX, y: point.y * fit.scaleY + fit.offsetY };
}

/** Phones get the 768 tier and the lower DPR cap. */
export function isPhoneViewport(cssWidth: number): boolean {
  return cssWidth <= tune.phoneMaxWidth;
}

/** The chapter's focal point for this viewport: the phone one on phones and portrait screens. */
export function focalFor(chapter: Pick<Chapter, "focal">, cssWidth: number, cssHeight: number): Point {
  return isPhoneViewport(cssWidth) || cssHeight > cssWidth ? chapter.focal.phone : chapter.focal.desktop;
}
