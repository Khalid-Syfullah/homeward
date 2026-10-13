"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { site, tune, type Story } from "@/content/story";
import { endPanelOpacity } from "./EndPanel";
import { readStageParams } from "./engine";
import { nextStop, prevStop, readProgress, scrollToP, stopOf } from "./nav";
import { SoundEngine } from "./sound";
import { useStageEngine, useStageFrame } from "./useStage";
import styles from "./Chrome.module.css";

/** Keys that move the film, and what they do. */
const KEYS: Record<string, "next" | "prev" | "start" | "end"> = {
  ArrowDown: "next",
  ArrowRight: "next",
  PageDown: "next",
  ArrowUp: "prev",
  ArrowLeft: "prev",
  PageUp: "prev",
  Home: "start",
  End: "end",
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * The chrome around the film: a skip link, the wordmark (a link to the top), the chapter rail with
 * one tick per chapter, a sound toggle (off until the visitor turns it on), a thin progress line and a
 * polite live region that names each chapter as it arrives. Keyboard: arrow keys and PageUp and
 * PageDown move chapter by chapter, Home and End go to the ends.
 *
 * Everything here is driven by the same p as the canvas: the rail, the progress line and the sound
 * engine are written to on every stage frame, never through React state.
 */
export function Chrome({ story }: { story: Story }) {
  const engine = useStageEngine();
  const [sound] = useState(() => new SoundEngine());
  const [soundOn, setSoundOn] = useState(false);

  const line = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const ticks = useRef(new Map<string, HTMLButtonElement>());
  const live = useRef<HTMLParagraphElement>(null);
  const shown = useRef<string | null>(null);
  /** Where a keyboard or rail jump is heading, so a second press during the scroll continues from there. */
  const heading = useRef<number | null>(null);
  /** The skip link was used: move focus into the end panel once it is showing. */
  const wantEnd = useRef(false);

  useEffect(() => sound.attach(), [sound]);

  useEffect(() => {
    // Children's effects run before the stage attaches, so read the URL parameter directly.
    if (!readStageParams(window.location.search).hud) return;
    window.homewardSound = sound;
    return () => {
      if (window.homewardSound === sound) delete window.homewardSound;
    };
  }, [sound]);

  const go = (p: number, thenEnd = false) => {
    heading.current = p;
    wantEnd.current = thenEnd;
    scrollToP(p);
  };

  // Keyboard.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const action = KEYS[event.key];
    if (!action || isEditable(event.target)) return;
    event.preventDefault();
    const here = heading.current ?? readProgress();
    if (action === "start") go(0);
    else if (action === "end") go(1);
    else if (action === "next") go(nextStop(here, story));
    else go(prevStop(here, story));
  });

  const reached = useEffectEvent(() => {
    const goal = heading.current;
    if (goal !== null && Math.abs(readProgress() - goal) < tune.nav.atStopVh / story.totalVh) heading.current = null;
  });

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => onKey(event);
    // The jump has landed.
    const landed = () => {
      heading.current = null;
    };
    // Browsers without scrollend: the jump has landed once the scroll is within reach of where it was heading.
    const nearing = () => reached();
    // Any scrolling the visitor does themselves ends the jump in progress.
    const taken = () => {
      heading.current = null;
      wantEnd.current = false;
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("scrollend", landed);
    window.addEventListener("scroll", nearing, { passive: true });
    window.addEventListener("wheel", taken, { passive: true });
    window.addEventListener("touchstart", taken, { passive: true });
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("scrollend", landed);
      window.removeEventListener("scroll", nearing);
      window.removeEventListener("wheel", taken);
      window.removeEventListener("touchstart", taken);
    };
  }, []);

  useStageFrame((f) => {
    // Progress line and rail fill.
    if (line.current) line.current.style.transform = `scaleX(${f.p.toFixed(5)})`;
    const n = f.story.chapters.length;
    if (fill.current) {
      const along = n > 1 ? Math.min(1, (f.chapter.index + f.t) / (n - 1)) : 1;
      fill.current.style.transform = `scaleY(${along.toFixed(5)})`;
    }

    // Which tick is current.
    if (shown.current !== f.chapter.id) {
      const first = shown.current === null;
      shown.current = f.chapter.id;
      for (const [id, el] of ticks.current) {
        if (id === f.chapter.id) {
          el.setAttribute("aria-current", "step");
          el.dataset.current = "";
        } else {
          el.removeAttribute("aria-current");
          delete el.dataset.current;
        }
      }
      if (live.current && !first) {
        live.current.textContent = site.a11y.announce
          .replace("{n}", String(f.chapter.index + 1))
          .replace("{total}", String(n))
          .replace("{title}", f.chapter.title);
      }
    }

    // Sound follows the chapter chapterAt(p) names.
    sound.setChapter(f.chapter, f.story);

    // After the skip link, focus the end panel when it is showing.
    if (wantEnd.current) {
      if (endPanelOpacity(f.p, f.story) >= tune.endPanel.interactiveAt) {
        wantEnd.current = false;
        document.getElementById("end")?.focus({ preventScroll: true });
      } else {
        return true;
      }
    }
  });

  const toggleSound = () => {
    // setEnabled sets sound.enabled before its first await, so this is a plain read after the click.
    void sound.setEnabled(!sound.enabled);
    setSoundOn(sound.enabled);
  };

  const skipToEnd = (event: React.MouseEvent) => {
    event.preventDefault();
    go(1, true);
    engine?.wake();
  };

  const toTop = (event: React.MouseEvent) => {
    event.preventDefault();
    go(0);
  };

  const count = story.chapters.length;

  return (
    <div className={styles.chrome} data-chrome>
      <a className={styles.skip} href="#end" onClick={skipToEnd}>
        {site.skip}
      </a>

      <header className={styles.header}>
        <a className={styles.wordmark} href="#top" onClick={toTop} aria-label={site.a11y.wordmark}>
          {site.wordmark}
        </a>
      </header>

      <nav className={styles.rail} aria-label={site.a11y.rail} style={{ "--rail-vh": `${tune.nav.railVh}vh`, "--rail-max": `${tune.nav.railMaxRem}rem` } as React.CSSProperties}>
        <div className={styles.track} aria-hidden="true">
          <div ref={fill} className={styles.fill} />
        </div>
        <ol className={styles.ticks}>
          {story.chapters.map((c) => (
            <li key={c.id} className={styles.item} style={{ top: `${count > 1 ? (c.index / (count - 1)) * 100 : 0}%` }}>
              <button
                type="button"
                className={styles.tick}
                ref={(el) => {
                  if (el) ticks.current.set(c.id, el);
                  else ticks.current.delete(c.id);
                }}
                aria-label={`${c.index + 1}. ${c.title}`}
                onClick={() => go(stopOf(c, story))}
              >
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.label} aria-hidden="true">
                  {c.title}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <button type="button" className={styles.sound} onClick={toggleSound} data-on={soundOn ? "" : undefined}>
        <span className={styles.bars} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {soundOn ? site.sound.on : site.sound.off}
      </button>

      <div className={styles.line} aria-hidden="true">
        <div ref={line} className={styles.lineFill} />
      </div>

      <p ref={live} className={styles.live} aria-live="polite" role="status" />
    </div>
  );
}
