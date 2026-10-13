import { tune, type Story, type StoryChapter } from "@/content/story";
import { captionWindow } from "./captionTiming";

/**
 * Chapter navigation as pure math on p, plus the one function that scrolls the page to a p.
 *
 * A chapter's stop is the scroll position where its caption is fully in, which is also clear of
 * the join window before it; the first chapter's stop is the top. The last stop is the bottom of
 * the page (the end screen). The rail, the keyboard and the skip link all go through these.
 */

/** p of a chapter's stop. */
export function stopOf(chapter: StoryChapter, story: Story): number {
  if (chapter.index === 0) return 0;
  const vh = Math.min(captionWindow(chapter, story).inEnd, chapter.endVh);
  return vh / story.totalVh;
}

/** Every stop in order: one per chapter, then the bottom of the page. */
export function stops(story: Story): number[] {
  return [...story.chapters.map((c) => stopOf(c, story)), 1];
}

/** The stop of the next chapter below p (the end of the page after the last one). */
export function nextStop(p: number, story: Story): number {
  const slack = tune.nav.atStopVh / story.totalVh;
  return stops(story).find((s) => s > p + slack) ?? 1;
}

/** The stop of the chapter above p: the start of the chapter you are in, or the one before if you are at it. */
export function prevStop(p: number, story: Story): number {
  const slack = tune.nav.atStopVh / story.totalVh;
  const list = stops(story);
  for (let i = list.length - 1; i >= 0; i--) if (list[i] < p - slack) return list[i];
  return 0;
}

/** Raw scroll progress of the window over the whole page, 0..1 (the same reading the stage clock uses). */
export function readProgress(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Scroll the window to progress p, smoothly unless the visitor prefers reduced motion. */
export function scrollToP(p: number) {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo({ top: Math.min(1, Math.max(0, p)) * Math.max(0, max), behavior: prefersReducedMotion() ? "instant" : "smooth" });
}
