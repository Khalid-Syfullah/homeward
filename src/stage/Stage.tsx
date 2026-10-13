"use client";

/**
 * The stage: the one full-viewport canvas the film plays on, driven by the stage engine (the
 * scroll clock, the frame store and the WebGL compositor in this folder). Children render over
 * the canvas as real DOM and read the same frame state through useStageFrame.
 *
 * Until the canvas has drawn, the loading frame stands in: the film's opening frame as a plain image in
 * the server-rendered HTML, so the browser paints it before any script runs. It is the same file the
 * frame store asks for first (the same URL, so it is fetched once), at the tier the store will play,
 * placed by the same cover fit, so the canvas takes over without a visible change (docs/PERF.md).
 *
 * ?hud=1 adds the dev HUD; see engine.ts for the other URL parameters.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { frameUrl, site, tune, type Story, type StoryChapter } from "@/content/story";
import { readStageParams, StageEngine } from "./engine";
import { PHONE_MEDIA } from "./fit";
import { parseManifest } from "./frameStore";
import { Hud } from "./Hud";
import { vignetteGradient } from "./looks";
import { StageContext } from "./useStage";
import styles from "./Stage.module.css";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- a merged declaration repeats React's type parameter
  interface ImgHTMLAttributes<T> {
    /** Element Timing: the browser records when this image was painted (npm run perf reads it). */
    elementtiming?: string;
  }
}

/** The Element Timing name of the loading frame (scripts/perf.mjs looks for it). */
const LOADING_FRAME_TIMING = "homeward-loading-frame";

interface StageProps {
  story: Story;
  /** Every clip's manifest as the server read it, by clip (null for a clip without frames). */
  manifests: Readonly<Record<string, unknown>>;
  children?: ReactNode;
}

const noSubscription = () => () => {};
const clientSearch = () => window.location.search;
const serverSearch = () => "";

const WIDEST = tune.tiers[0];
const NARROWEST = tune.tiers[tune.tiers.length - 1];

/** The opening frame's URLs at the widest tier and at the narrowest (phones), as far as its manifest has them. */
function loadingFrame(chapter: StoryChapter | undefined, manifests: Readonly<Record<string, unknown>>) {
  if (!chapter) return null;
  const manifest = parseManifest(chapter.clip, manifests[chapter.clip]);
  if (!manifest) return null;
  const at = (tier: number) => (manifest.tiers[tier] ? frameUrl(chapter.clip, tier, 0, manifest.version) : null);
  const wide = at(WIDEST);
  const narrow = at(NARROWEST);
  if (!wide && !narrow) return null;
  // The chapter's vignette at its first instant (looks.ts), as the canvas will draw it over the frame. The
  // CSS gradient is centred on the screen, so it is drawn for a vignette that closes toward the centre.
  const centred = chapter.look?.vignette?.toward === "centre";
  const vignette = centred ? vignetteGradient(chapter.look, 0, false) : null;
  const vignetteReduced = centred ? vignetteGradient(chapter.look, 0, true) : null;
  return { wide, narrow, focal: chapter.focal, vignette, vignetteReduced };
}

export function Stage({ story, manifests, children }: StageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine] = useState(() => new StageEngine(story, manifests));
  const search = useSyncExternalStore(noSubscription, clientSearch, serverSearch);
  const { hud } = readStageParams(search);
  const opening = useMemo(() => loadingFrame(story.chapters[0], manifests), [story, manifests]);

  useEffect(() => {
    engine.setStory(story);
  }, [engine, story]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return engine.attach(canvas);
  }, [engine]);

  // The canvas is an image whose description follows the chapter: its title and caption line.
  useEffect(
    () =>
      engine.subscribe((f) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const label = site.a11y.film.replace("{title}", f.chapter.caption.title).replace("{line}", f.chapter.caption.line);
        if (canvas.getAttribute("aria-label") !== label) canvas.setAttribute("aria-label", label);
      }),
    [engine],
  );

  const first = story.chapters[0];
  const placement = opening
    ? ({
        "--aspect": tune.frameAspect,
        "--fx-desktop": opening.focal.desktop.x,
        "--fy-desktop": opening.focal.desktop.y,
        "--fx-phone": opening.focal.phone.x,
        "--fy-phone": opening.focal.phone.y,
        "--vignette": opening.vignette ?? "none",
        "--vignette-reduced": opening.vignetteReduced ?? "none",
      } as CSSProperties)
    : undefined;
  return (
    <StageContext value={engine}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        aria-label={site.a11y.film.replace("{title}", first.caption.title).replace("{line}", first.caption.line)}
      />
      {opening ? (
        <div className={styles.loading} style={placement} aria-hidden="true" data-loading-frame>
          <picture>
            {opening.wide && opening.narrow ? <source media={PHONE_MEDIA} srcSet={opening.narrow} /> : null}
            {/* A plain image, not next/image: it is painted from the HTML before any script runs. */}
            <img
              className={styles.poster}
              src={opening.wide ?? opening.narrow ?? undefined}
              alt=""
              fetchPriority="high"
              elementtiming={LOADING_FRAME_TIMING}
            />
          </picture>
        </div>
      ) : null}
      {children}
      {hud ? <Hud story={story} /> : null}
    </StageContext>
  );
}
