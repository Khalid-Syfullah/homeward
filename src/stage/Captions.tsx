"use client";

import { useRef } from "react";
import { tune, type Story } from "@/content/story";
import { captionOpacity, gateEase } from "./captionTiming";
import { useStageFrame } from "./useStage";
import styles from "./Captions.module.css";

/**
 * The captions: each present chapter's title and one line, real text in a column that keeps clear of
 * the subject (left on desktop, the lower third on phones; Captions.module.css). Opacity is written
 * straight into the DOM on every stage frame, so a scrub never re-renders the tree.
 *
 * A caption's opacity is its scroll window (captionTiming.ts, a pure function of p that is zero before
 * the previous join ends and by the time its own join begins) times a settle gate: the gate opens
 * once the scroll has been slower than tune.captions.settleVhPerS for tune.captions.settleMs, eases
 * in over fadeInMs, and closes over fadeOutMs as soon as the scroll speeds up again. So a caption
 * never shows over a moving picture, never overlaps a join, and replays the same way scrubbing back.
 */
export function Captions({ story }: { story: Story }) {
  const items = useRef(new Map<string, HTMLElement>());
  const gate = useRef({ dwell: 0, level: 0 });

  useStageFrame((f) => {
    const c = tune.captions;
    const g = gate.current;
    const ms = Math.min(f.dt, 0.1) * 1000;
    const speed = Math.abs(f.velocity) * f.story.totalVh;
    const slow = speed < c.settleVhPerS;
    g.dwell = slow ? g.dwell + ms : 0;
    const open = g.dwell >= c.settleMs;
    const target = open ? 1 : 0;
    g.level = open ? Math.min(1, g.level + ms / c.fadeInMs) : Math.max(0, g.level - ms / c.fadeOutMs);
    const eased = gateEase(g.level);

    let wanted = false;
    for (const chapter of f.story.chapters) {
      const el = items.current.get(chapter.id);
      if (!el) continue;
      const window = captionOpacity(chapter, f.p, f.story);
      if (window > 0) wanted = true;
      const o = window * eased;
      const text = o === 0 ? "0" : o.toFixed(4);
      if (el.style.opacity !== text) el.style.opacity = text;
      const rise = f.reducedMotion || o === 0 ? "" : `translateY(${((1 - o) * c.risePx).toFixed(2)}px)`;
      if (el.style.transform !== rise) el.style.transform = rise;
    }

    // Keep rendering while the dwell is counting down or the gate is still easing.
    if (!wanted) return false;
    return (slow && !open) || g.level !== target;
  });

  return (
    <div className={styles.column}>
      {story.chapters.map((c) => (
        <section
          key={c.id}
          ref={(el) => {
            if (el) items.current.set(c.id, el);
            else items.current.delete(c.id);
          }}
          className={styles.caption}
          data-chapter={c.id}
        >
          <h2 className={styles.title}>{c.caption.title}</h2>
          <p className={styles.line}>{c.caption.line}</p>
        </section>
      ))}
    </div>
  );
}
