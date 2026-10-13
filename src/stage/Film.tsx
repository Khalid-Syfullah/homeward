"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { chapters, endScreenT, manifestPath, resolveStory, site } from "@/content/story";
import { Captions } from "./Captions";
import { Stage } from "./Stage";
import { useStageFrame } from "./useStage";
import styles from "./Film.module.css";

interface FilmProps {
  /** Optional clips the server found no frames for. */
  initialMissing: string[];
}

/**
 * The page shell: a tall scroll track (the film's scroll length plus the end screen) holding one
 * sticky full-viewport stage. Everything inside the stage reads the same progress p.
 */
export function Film({ initialMissing }: FilmProps) {
  const [missing, setMissing] = useState<string[]>(initialMissing);
  const story = useMemo(() => resolveStory((clip) => !missing.includes(clip)), [missing]);

  // Re-check optional clips on the client, so frames added after the build are picked up.
  useEffect(() => {
    const controller = new AbortController();
    const optional = chapters.filter((c) => c.optional);
    Promise.all(
      optional.map((c) =>
        fetch(manifestPath(c.clip), { cache: "no-store", signal: controller.signal })
          .then((r) => (r.ok ? null : c.clip))
          .catch(() => (controller.signal.aborted ? undefined : c.clip)),
      ),
    ).then((results) => {
      if (controller.signal.aborted || results.some((r) => r === undefined)) return;
      const next = results.filter((r): r is string => typeof r === "string");
      setMissing((prev) => (prev.join() === next.join() ? prev : next));
    });
    return () => controller.abort();
  }, []);

  return (
    <main className={styles.track} style={{ height: `calc(${story.totalVh}vh + 100vh)` }}>
      <div className={styles.stage}>
        <Stage story={story}>
          <Captions story={story} />
          <EndScreen />
        </Stage>
      </div>
    </main>
  );
}

/** The end screen after the last frame; its opacity follows p through the end screen's scroll. */
function EndScreen() {
  const ref = useRef<HTMLElement>(null);
  useStageFrame((f) => {
    if (ref.current) ref.current.style.opacity = String(endScreenT(f.p, f.story));
  });
  return (
    <section ref={ref} className={styles.end} aria-label="End">
      <h1 className={styles.endHeading}>{site.end.heading}</h1>
      <p className={styles.endLine}>{site.end.line}</p>
    </section>
  );
}
