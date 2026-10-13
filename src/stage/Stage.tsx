"use client";

/**
 * The stage: the one full-viewport canvas the film plays on, driven by the stage engine (the
 * scroll clock, the frame store and the WebGL compositor in this folder). Children render over
 * the canvas as real DOM and read the same frame state through useStageFrame.
 *
 * ?hud=1 adds the dev HUD; see engine.ts for the other URL parameters.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Story } from "@/content/story";
import { readStageParams, StageEngine } from "./engine";
import { Hud } from "./Hud";
import { StageContext } from "./useStage";
import styles from "./Stage.module.css";

interface StageProps {
  story: Story;
  children?: ReactNode;
}

const noSubscription = () => () => {};
const clientSearch = () => window.location.search;
const serverSearch = () => "";

export function Stage({ story, children }: StageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine] = useState(() => new StageEngine(story));
  const search = useSyncExternalStore(noSubscription, clientSearch, serverSearch);
  const { hud } = readStageParams(search);

  useEffect(() => {
    engine.setStory(story);
  }, [engine, story]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return engine.attach(canvas);
  }, [engine]);

  return (
    <StageContext value={engine}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      {children}
      {hud ? <Hud story={story} /> : null}
    </StageContext>
  );
}
