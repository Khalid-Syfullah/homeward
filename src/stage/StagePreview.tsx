"use client";

/**
 * Phase 1 preview stage: maps the raw scroll position to p and draws the nearest frame of the
 * chapter at p onto a canvas, cover-fitted around the chapter's focal point. It exists so the
 * page plays the placeholder (or real) frames from day one; phase 3 replaces it with the scroll
 * clock, the frame store and the WebGL compositor in src/stage.
 *
 * It never clears the canvas: if the wanted frame is not loaded yet, it draws the nearest loaded
 * frame of the same chapter, and if none is, it keeps what is already on screen.
 */
import { useEffect, useRef, type RefObject } from "react";
import {
  chapterAt,
  endScreenT,
  frameAt,
  framePath,
  manifestPath,
  tune,
  type Story,
  type StoryChapter,
} from "@/content/story";
import styles from "./StagePreview.module.css";

interface StagePreviewProps {
  story: Story;
  /** Element faded in over the end screen (opacity follows p). */
  endScreenRef?: RefObject<HTMLElement | null>;
}

/** Progress p (0..1) of the window's scroll position over the whole page. */
function scrollProgress(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

export function StagePreview({ story, endScreenRef }: StagePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const images = new Map<string, HTMLImageElement>();
    const counts = new Map<string, number>();
    const requested = new Set<string>();
    let raf = 0;
    let drawnKey = "";
    let disposed = false;

    const isPhone = () => window.innerWidth <= tune.phoneMaxWidth;
    const tier = () => (isPhone() ? tune.tiers[tune.tiers.length - 1] : tune.tiers[0]);
    const frameCount = (c: StoryChapter) => counts.get(c.clip) ?? c.frames;

    const schedule = () => {
      if (!raf && !disposed) raf = requestAnimationFrame(draw);
    };

    const loadManifest = (c: StoryChapter) => {
      if (requested.has(c.clip)) return;
      requested.add(c.clip);
      fetch(manifestPath(c.clip), { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((m: { tiers?: Record<string, { count?: number }> } | null) => {
          const count = m?.tiers?.[String(tier())]?.count;
          if (typeof count === "number" && count > 0 && count !== c.frames) {
            counts.set(c.clip, count);
            schedule();
          }
        })
        .catch(() => {});
    };

    const image = (c: StoryChapter, index: number) => {
      const url = framePath(c.clip, tier(), index);
      let img = images.get(url);
      if (!img) {
        img = new Image();
        img.decoding = "async";
        img.onload = schedule;
        img.src = url;
        images.set(url, img);
      }
      return img;
    };

    const ready = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

    const preload = (c: StoryChapter) => {
      loadManifest(c);
      const n = frameCount(c);
      for (let i = 0; i < n; i++) image(c, i);
    };

    const resize = () => {
      const cap = isPhone() ? tune.dprCapPhone : tune.dprCapDesktop;
      const dpr = Math.min(window.devicePixelRatio || 1, cap);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawnKey = "";
      }
    };

    const draw = () => {
      raf = 0;
      resize();
      const p = scrollProgress();
      const chapter = chapterAt(p, story);
      const n = frameCount(chapter);
      const wanted = Math.round(frameAt(p, story, n));

      preload(chapter);
      for (let k = 1; k <= tune.lookaheadChapters; k++) {
        const next = story.chapters[chapter.index + k];
        if (next) preload(next);
      }

      // The wanted frame, else the nearest loaded one in this chapter.
      let index = -1;
      for (let d = 0; d < n && index < 0; d++) {
        if (wanted - d >= 0 && ready(image(chapter, wanted - d))) index = wanted - d;
        else if (wanted + d < n && ready(image(chapter, wanted + d))) index = wanted + d;
      }

      if (index >= 0) {
        const key = `${chapter.clip}/${tier()}/${index}/${canvas.width}x${canvas.height}`;
        if (key !== drawnKey) {
          drawCover(ctx, image(chapter, index), canvas.width, canvas.height, isPhone() ? chapter.focal.phone : chapter.focal.desktop);
          drawnKey = key;
        }
      }

      const end = endScreenRef?.current;
      if (end) end.style.opacity = String(endScreenT(p, story));
    };

    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const img of images.values()) img.onload = null;
    };
  }, [story, endScreenRef]);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}

/** Draw img to cover a w x h canvas, keeping the focal point (0..1) as central as the crop allows. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  focal: { x: number; y: number },
) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = Math.min(0, Math.max(w - dw, w / 2 - focal.x * dw));
  const dy = Math.min(0, Math.max(h - dh, h / 2 - focal.y * dh));
  ctx.drawImage(img, dx, dy, dw, dh);
}
