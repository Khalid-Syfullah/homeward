import { tune } from "@/content/story";

/**
 * The page flips of c07. The displayed frame index chases the frame index the scroll asks for, with
 * a little smoothing on top of the scroll clock's (an exponential approach, tune.pages.smoothOmega)
 * and a cap on how far one render may move it (tune.pages.maxFrames displayed frames), so a fast
 * flick plays the pages one after another instead of strobing through them.
 *
 * What is drawn is therefore the pure function of p only once it has caught up: at rest the displayed
 * frame equals the requested one exactly, and it also does while the chapter is out of sight, after a
 * jump (a navigation), when the frame count changes (another tier) and under reduced motion, which
 * keeps no lag. Scrubbing back replays the same way, because the chase has no memory beyond the one
 * number it is chasing from.
 */
export class PageFlip {
  private frame = 0;
  private count = 0;
  private lastP = Number.NaN;

  /**
   * One render's step. `target` is the requested fractional frame index (0 .. count-1), `dt` the seconds
   * since the last render, `follow` whether the chapter is on screen (else it simply sits on the
   * target) and `exact` whether to skip the chase altogether (reduced motion). Returns the displayed
   * fractional frame index.
   */
  step(target: number, count: number, p: number, dt: number, follow: boolean, exact: boolean): number {
    const jumped = !Number.isFinite(this.lastP) || Math.abs(p - this.lastP) > tune.clockSnapJump;
    this.lastP = p;
    if (!follow || exact || jumped || count !== this.count) {
      this.count = count;
      this.frame = target;
      return this.frame;
    }
    const gap = target - this.frame;
    const wanted = gap * (1 - Math.exp(-tune.pages.smoothOmega * Math.min(Math.max(dt, 0), tune.clockMaxDt)));
    const move = Math.min(Math.max(wanted, -tune.pages.maxFrames), tune.pages.maxFrames);
    this.frame += move;
    // Close enough is there: the last sliver would take the smoothing forever to cover.
    if (Math.abs(target - this.frame) < tune.pages.restFrames) this.frame = target;
    return this.frame;
  }

  /** Whether the displayed frame is still on its way to the target (another render is needed). */
  chasing(target: number): boolean {
    return this.frame !== target;
  }
}
