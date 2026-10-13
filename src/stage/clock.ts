import { tune } from "@/content/story";

/**
 * The scroll clock. Scroll position is the clock of the whole film: the raw scroll progress is
 * the target, and a critically damped spring follows it, so the smoothed progress p never
 * overshoots and comes to rest without wobble. Each step is the spring's closed-form solution,
 * not a numerical integrator, so the motion is identical at 30, 60 or 144 Hz (frame-rate
 * independent). Under reduced motion the clock snaps straight to the scroll.
 *
 * Every visual and audio state downstream is a pure function of p, so scrubbing back replays
 * exactly. The clock itself only remembers its velocity, which decays to zero at rest.
 */

export interface SpringState {
  /** Position. */
  x: number;
  /** Velocity, in position units per second. */
  v: number;
}

/**
 * One exact step of a critically damped spring pulling x toward target with angular frequency
 * omega (1/s), over dt seconds: x(t) = target + (d + (v + omega d) t) e^(-omega t), d = x - target.
 */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): SpringState {
  const d = x - target;
  const e = Math.exp(-omega * dt);
  const k = (v + omega * d) * dt;
  return { x: target + (d + k) * e, v: (v - omega * k) * e };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class ScrollClock {
  /** Smoothed progress, 0..1. */
  p = 0;
  /** Rate of change of p, in p per second (signed: positive while scrolling down). */
  velocity = 0;
  /** Raw scroll progress the clock follows, 0..1. */
  target = 0;
  /** Fixed progress (?p=0.42): the clock ignores the scroll and holds here. */
  frozen: number | null = null;
  /** Snap to the scroll instead of following it (prefers-reduced-motion). */
  reducedMotion = false;

  private x = 0;
  /** The target jumped further than tune.clockSnapJump since the last tick (a navigation). */
  private jumped = false;

  constructor(private readonly omega: number = tune.clockOmega) {}

  setTarget(target: number) {
    const next = clamp01(target);
    if (Math.abs(next - this.target) > tune.clockSnapJump) this.jumped = true;
    this.target = next;
  }

  /** Jump to the target with no velocity (first frame, or a navigation rather than a scrub). */
  snap() {
    this.x = this.target;
    this.p = this.target;
    this.velocity = 0;
  }

  /** Whether the clock is at rest on its target. */
  get settled(): boolean {
    return this.frozen !== null || (this.p === this.target && this.velocity === 0);
  }

  /** Advance by dt seconds. Returns true while p is still moving (another frame is needed). */
  tick(dt: number): boolean {
    const jumped = this.jumped;
    this.jumped = false;
    if (this.frozen !== null) {
      this.x = this.p = clamp01(this.frozen);
      this.velocity = 0;
      return false;
    }
    if (jumped) {
      // A navigation (scroll restoration, a skip link): land on it at rest, with no smear.
      this.snap();
      return false;
    }
    const step = Math.min(Math.max(dt, 0), tune.clockMaxDt);

    if (this.reducedMotion) {
      // Snap, but still report how fast p moved, so listeners can tell a scrub from rest.
      // One more tick after the scroll stops brings the velocity back to zero.
      const before = this.p;
      this.snap();
      this.velocity = step > 0 ? (this.p - before) / step : 0;
      return this.velocity !== 0;
    }

    const next = springStep(this.x, this.velocity, this.target, this.omega, step);
    if (Math.abs(next.x - this.target) < tune.clockRestP && Math.abs(next.v) < tune.clockRestVelocity) {
      this.snap();
      return false;
    }
    this.x = next.x;
    this.velocity = next.v;
    this.p = clamp01(next.x);
    return true;
  }
}
