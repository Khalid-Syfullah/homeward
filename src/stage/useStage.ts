"use client";

import { createContext, useContext, useEffect, useEffectEvent } from "react";
import type { StageEngine, StageListener } from "./engine";

/** The stage engine of the surrounding <Stage>. */
export const StageContext = createContext<StageEngine | null>(null);

export function useStageEngine(): StageEngine | null {
  return useContext(StageContext);
}

/**
 * Run listener on every rendered stage frame, with the same p the canvas used. Write to the DOM
 * through refs inside it rather than setting React state, so a scrub never re-renders the tree.
 * Return true from it to ask for another frame (ambient motion).
 */
export function useStageFrame(listener: StageListener) {
  const engine = useStageEngine();
  const onFrame = useEffectEvent(listener);
  useEffect(() => engine?.subscribe((frame) => onFrame(frame)), [engine]);
}
