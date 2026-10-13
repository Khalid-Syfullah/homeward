"use client";

/**
 * The dev HUD (?hud=1): what the engine is doing at this p, next to the story map it should agree
 * with. It writes its readout straight into the DOM on every stage frame, so it never re-renders.
 */
import { useRef } from "react";
import { joinAt, tune, type Story } from "@/content/story";
import type { StageFrame, StageStats } from "./engine";
import { MB } from "./frameStore";
import { useStageEngine, useStageFrame } from "./useStage";
import styles from "./Hud.module.css";

const fixed = (n: number, digits: number) => n.toFixed(digits);
const signed = (n: number, digits: number) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
const mb = (bytes: number) => (bytes / MB).toFixed(1);
/** The 1-based file name of a frame index, as on disk and on the placeholders. */
const file = (index: number) => `f_${String(index + 1).padStart(3, "0")}`;

function readout(f: StageFrame, s: StageStats, fps: number | null): string {
  const c = f.chapter;
  const i0 = Math.floor(f.frame);
  const i1 = Math.min(i0 + 1, f.count - 1);
  const shown = f.shown;
  const join = joinAt(f.p, f.story);
  const store = s.store;
  const gpu = s.compositor;
  const ch = s.chapter;

  const lines = [
    `p         ${fixed(f.p, 5)}   target ${fixed(f.target, 5)}${f.frozen ? "   FROZEN (?p)" : ""}`,
    `velocity  ${signed(f.velocity, 4)} p/s   ${f.direction > 0 ? "down" : "up"}${f.reducedMotion ? "   reduced motion" : ""}`,
    `chapter   ${c.index + 1}/${f.story.chapters.length} ${c.id} "${c.title}"   p ${fixed(c.startP, 4)} to ${fixed(c.endP, 4)}`,
    `local t   ${fixed(f.t, 4)}`,
    `frame     ${fixed(f.frame, 3)} of 0..${f.count - 1}   ${file(i0)}${i1 !== i0 ? ` + ${file(i1)} mix ${fixed(f.frame - i0, 3)}` : ""}`,
    `drawn     ${
      shown
        ? `${shown.a.clip} ${file(shown.a.index)}${shown.b !== shown.a ? ` + ${file(shown.b.index)} mix ${fixed(shown.mix, 3)}` : ""} @${shown.a.tier}${shown.exact ? "" : "   STAND-IN (nearest loaded)"}`
        : "nothing loaded yet"
    }`,
    `join      ${join ? `${join.window.type} ${join.window.from.id} > ${join.window.to.id}   t ${fixed(join.t, 3)}` : "none"}`,
  ];
  if (store) {
    lines.push(
      `tier      ${store.tier} (${store.tierReason})   canvas ${gpu ? `${gpu.width}x${gpu.height} ${gpu.kind}` : "none"} @${fixed(f.dpr, 2)}x`,
      `decoded   ${store.frames} frames ${mb(store.decodedBytes)} / ${mb(store.capBytes)} MB   plan ${store.planned}`,
      `encoded   ${store.encoded} frames ${mb(store.encodedBytes)} / ${mb(store.encodedCapBytes)} MB   plan ${store.prefetch}`,
      `gpu       ${gpu ? `${gpu.textures} textures ${mb(gpu.textureBytes)} MB` : "none"}`,
      `loads     fetching ${store.fetching}   decoding ${store.decoding}   failed ${store.failed}   manifests ${store.manifests}`,
    );
  }
  if (ch) lines.push(`this clip ${ch.decoded}/${ch.count} decoded   ${ch.encoded}/${ch.count} encoded   ${ch.manifest} frames @${ch.tier}`);
  lines.push(`fps       ${fps === null ? "measuring" : Math.round(fps)}`);
  return lines.join("\n");
}

export function Hud({ story }: { story: Story }) {
  const engine = useStageEngine();
  const textRef = useRef<HTMLPreElement>(null);
  const rowsRef = useRef<HTMLTableSectionElement>(null);
  const meter = useRef({ frames: 0, seconds: 0, fps: null as number | null });

  useStageFrame((f) => {
    const m = meter.current;
    if (f.dt > 0) {
      m.frames++;
      m.seconds += f.dt;
      if (m.seconds >= 1) {
        m.fps = m.frames / m.seconds;
        m.frames = 0;
        m.seconds = 0;
      }
    }
    if (textRef.current && engine) textRef.current.textContent = readout(f, engine.stats(), m.fps);
    for (const row of rowsRef.current?.rows ?? []) {
      row.toggleAttribute("data-current", row.dataset.id === f.chapter.id);
    }
  });

  return (
    <aside className={styles.hud} aria-label="Developer HUD">
      <pre ref={textRef} className={styles.readout} />
      <details className={styles.section} open>
        <summary>Story map</summary>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>chapter</th>
              <th>p from</th>
              <th>p to</th>
              <th>vh</th>
              <th>frames</th>
              <th>join</th>
            </tr>
          </thead>
          <tbody ref={rowsRef}>
            {story.chapters.map((c) => (
              <tr key={c.id} data-id={c.id}>
                <td>{c.number}</td>
                <td>{c.id}</td>
                <td>{c.startP.toFixed(4)}</td>
                <td>{c.endP.toFixed(4)}</td>
                <td>{c.scrollVh}</td>
                <td>{c.frames}</td>
                <td>{c.joinOut}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.note}>
          film ends at p {story.filmEndP.toFixed(4)}, {story.totalVh} vh in all
          {story.skipped.length ? `, skipped: ${story.skipped.join(", ")}` : ""}
        </p>
      </details>
      <details className={styles.section}>
        <summary>tune</summary>
        <pre className={styles.tune}>{JSON.stringify(tune, null, 2)}</pre>
      </details>
    </aside>
  );
}
