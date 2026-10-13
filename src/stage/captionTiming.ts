import { joinWindow, tune, type Story, type StoryChapter } from "@/content/story";

/**
 * Caption timing, as pure math. A chapter's caption lives in a window of scroll that is kept clear
 * of every join: it starts tune.captions.enterVh after the previous join window ends (or after the
 * chapter starts, when there is none) and is exactly gone tune.captions.exitVh before its own join
 * window starts. Inside the window it fades in and out over tune.captions.enterFadeVh and exitFadeVh.
 * The stage then multiplies this by the "settled" gate (Captions.tsx): the picture must also have
 * stopped moving.
 */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const between = (lo: number, hi: number, v: number) => (hi > lo ? smooth((v - lo) / (hi - lo)) : v >= hi ? 1 : 0);

export interface CaptionWindow {
  /** In viewport heights of scroll: fully in from inEnd to outStart, zero before inStart and from outEnd. */
  inStart: number;
  inEnd: number;
  outStart: number;
  outEnd: number;
}

export function captionWindow(chapter: StoryChapter, story: Story): CaptionWindow {
  const c = tune.captions;
  const before = chapter.index > 0 ? joinWindow(story.chapters[chapter.index - 1], story) : null;
  const after = joinWindow(chapter, story);
  const lo = before ? before.endP * story.totalVh : chapter.startVh;
  const hi = after ? after.startP * story.totalVh : chapter.endVh;
  const inStart = lo + c.enterVh;
  const outEnd = hi - c.exitVh;
  return { inStart, inEnd: inStart + c.enterFadeVh, outStart: outEnd - c.exitFadeVh, outEnd };
}

/** The caption's opacity from the window alone, 0..1: a pure function of p, zero outside the window. */
export function captionOpacity(chapter: StoryChapter, p: number, story: Story): number {
  const w = captionWindow(chapter, story);
  const vh = clamp01(p) * story.totalVh;
  if (vh <= w.inStart || vh >= w.outEnd) return 0;
  return between(w.inStart, w.inEnd, vh) * (1 - between(w.outStart, w.outEnd, vh));
}

/** Ease for the settle gate. */
export const gateEase = smooth;
