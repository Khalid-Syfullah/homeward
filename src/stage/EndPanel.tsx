"use client";

import { useRef } from "react";
import { endScreenT, site, tune, type Story } from "@/content/story";
import { useStageFrame } from "./useStage";
import styles from "./EndPanel.module.css";

const smooth = (t: number) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

/**
 * The end panel's opacity, 0..1: a pure function of p, exactly zero until the end screen's scroll
 * reaches tune.endPanel.appearFrom (so it never shows over the film) and one from appearTo on.
 */
export function endPanelOpacity(p: number, story: Story): number {
  const { appearFrom, appearTo } = tune.endPanel;
  const t = endScreenT(p, story);
  if (t <= appearFrom) return 0;
  return smooth((t - appearFrom) / (appearTo - appearFrom));
}

/** A link is real once its address is anything but the "#" placeholder kept in story.ts. */
const hasRealLink = site.end.link.href !== "#" && site.end.link.href !== "";

/**
 * The end screen. After the last frame the stage holds on the sky and this calm panel (ink on paper at
 * 92 percent, in the caption column) fades in with the closing line, a Replay button and the one
 * link slot. Its opacity is written straight into the DOM on every stage frame; while it is hidden
 * it is out of the tab order and the accessibility tree.
 */
export function EndPanel() {
  const ref = useRef<HTMLElement>(null);

  useStageFrame((f) => {
    const el = ref.current;
    if (!el) return;
    const o = endPanelOpacity(f.p, f.story);
    el.style.opacity = o === 0 ? "0" : o.toFixed(4);
    el.style.visibility = o > 0 ? "visible" : "hidden";
    el.style.pointerEvents = o >= tune.endPanel.interactiveAt ? "auto" : "none";
    el.style.transform = f.reducedMotion || o === 0 ? "" : `translateY(${((1 - o) * tune.captions.risePx).toFixed(2)}px)`;
  });

  const replay = (event: React.MouseEvent<HTMLButtonElement>) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    event.currentTarget.blur();
    window.scrollTo({ top: 0, behavior: reduced ? "instant" : "smooth" });
  };

  return (
    <section ref={ref} className={styles.panel} aria-label="End">
      <h1 className={styles.heading}>{site.end.heading}</h1>
      <p className={styles.line}>{site.end.line}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.replay} onClick={replay}>
          {site.replay}
        </button>
        {hasRealLink ? (
          <a className={styles.link} href={site.end.link.href}>
            {site.end.link.label}
          </a>
        ) : (
          <span className={styles.slot}>{site.end.link.label}</span>
        )}
      </div>
    </section>
  );
}
