"use client";

/**
 * The dev HUD (?hud=1): what the engine is doing at this p, next to the story map it should agree
 * with. It writes its readout straight into the DOM on every stage frame, so it never re-renders.
 *
 * Anchor picker: click the picture to print the point in normalised frame coordinates (the
 * coordinates story.ts anchors use), or drag a rectangle for a photoRect. The result is shown in
 * the readout, logged to the console and marked on screen.
 */
import { useEffect, useRef } from "react";
import { joinAt, tune, type Point, type Story } from "@/content/story";
import type { StageFrame, StageStats } from "./engine";
import { coverFit, focalFor, screenToFrame } from "./fit";
import { MB, type FramePick } from "./frameStore";
import { joinGeometry, type JoinGeometry } from "./joins";
import { useStageEngine, useStageFrame } from "./useStage";
import styles from "./Hud.module.css";

const fixed = (n: number, digits: number) => n.toFixed(digits);
const signed = (n: number, digits: number) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
const mb = (bytes: number) => (bytes / MB).toFixed(1);
/** The 1-based file name of a frame index, as on disk and on the placeholders. */
const file = (index: number) => `f_${String(index + 1).padStart(3, "0")}`;
const px = (n: number) => Math.round(n);

const PICKER_HINT = "click the picture for a point, drag for a rectangle (frame coordinates for story.ts anchors)";
/** A press that moves less than this many CSS pixels is a click, not a drag. */
const DRAG_PX = 4;

/** One picked pair of frames: clip, files and the blend. */
function frames(pick: FramePick | null): string {
  if (!pick) return "nothing loaded";
  const b = pick.b !== pick.a ? ` + ${file(pick.b.index)} mix ${fixed(pick.mix, 3)}` : "";
  return `${pick.a.clip} ${file(pick.a.index)}${b}${pick.exact ? "" : " STAND-IN"}`;
}

/** The join's live numbers, in CSS pixels. */
function joinLines(f: StageFrame): string[] {
  const j = f.join;
  if (!j) return ["join      none"];
  const w = j.window;
  const head = `join      ${j.kind}${j.kind !== w.type ? ` (story: ${w.type})` : ""} ${w.from.id} > ${w.to.id}   t ${fixed(j.t, 3)}   speed ${fixed(j.speed, 2)}`;
  const picks = `          out ${frames(j.out)}   in ${frames(j.into)}`;
  const lines = [head, picks];
  if (j.out && j.into) {
    const g: JoinGeometry = joinGeometry({
      kind: j.kind,
      t: j.t,
      speed: j.speed,
      width: f.width,
      height: f.height,
      px: 1,
      out: { width: j.out.a.width, height: j.out.a.height, focal: focalFor(w.from, f.width, f.height) },
      into: { width: j.into.a.width, height: j.into.a.height, focal: focalFor(w.to, f.width, f.height) },
      pupil: w.from.anchors.pupil,
      photoRect: w.from.anchors.photoRect,
    });
    switch (g.kind) {
      case "dissolve":
        lines.push(`          mix ${fixed(g.mix, 3)}${f.reducedMotion ? "   (reduced motion: every join is a dissolve)" : ""}`);
        break;
      case "push":
        lines.push(`          mix ${fixed(g.mix, 3)}   zoom out ${fixed(g.scaleOut, 3)} in ${fixed(g.scaleIn, 3)}   smear ${fixed(g.smear, 4)}`);
        break;
      case "portal":
        lines.push(
          `          centre ${px(g.centre.x)},${px(g.centre.y)} px   radius ${px(g.radius)} of ${px(g.reach)} px   zoom in ${fixed(g.scaleIn, 3)}`,
          `          feather ${fixed(g.feather, 1)}   bite ${fixed(g.bite, 1)}   ring ${fixed(g.ring, 1)} x ${fixed(g.ringStrength, 2)}   band ${fixed(g.band, 1)} px`,
        );
        break;
      case "rect":
        lines.push(
          `          rect ${px(g.rect.x)},${px(g.rect.y)} ${px(g.rect.w)}x${px(g.rect.h)} px   dissolve ${fixed(g.dissolve, 3)}   feather ${fixed(g.feather, 1)} px`,
        );
        break;
    }
  }
  return lines;
}

function readout(f: StageFrame, s: StageStats, fps: number | null, anchor: string, hold: string): string {
  const c = f.chapter;
  const i0 = Math.floor(f.frame);
  const i1 = Math.min(i0 + 1, f.count - 1);
  const shown = f.shown;
  const join = joinAt(f.p, f.story);
  const store = s.store;
  const gpu = s.compositor;
  const ch = s.chapter;

  const lines = [
    `p         ${fixed(f.p, 5)}   target ${fixed(f.target, 5)}${f.frozen ? `   FROZEN (${hold})` : ""}`,
    `velocity  ${signed(f.velocity, 4)} p/s   ${signed(f.velocity * f.story.totalVh, 1)} vh/s   ${f.direction > 0 ? "down" : "up"}${f.reducedMotion ? "   reduced motion" : ""}`,
    `chapter   ${c.index + 1}/${f.story.chapters.length} ${c.id} "${c.title}"   p ${fixed(c.startP, 4)} to ${fixed(c.endP, 4)}`,
    `local t   ${fixed(f.t, 4)}`,
    `frame     ${fixed(f.frame, 3)} of 0..${f.count - 1}   ${file(i0)}${i1 !== i0 ? ` + ${file(i1)} mix ${fixed(f.frame - i0, 3)}` : ""}`,
    `drawn     ${
      shown
        ? `${shown.a.clip} ${file(shown.a.index)}${shown.b !== shown.a ? ` + ${file(shown.b.index)} mix ${fixed(shown.mix, 3)}` : ""} @${shown.a.tier}${shown.exact ? "" : "   STAND-IN (nearest loaded)"}`
        : "nothing loaded yet"
    }`,
    ...(f.flip !== null ? [`flip      shows frame ${fixed(f.flip, 2)}${Math.abs(f.flip - f.frame) > 0.005 ? `   chasing ${fixed(f.frame, 2)}` : "   (caught up)"}`] : []),
    ...joinLines(f),
    `look      ${f.chapter.look ? `${Object.keys(f.chapter.look).join(", ")}   calm ${fixed(f.calm, 2)}` : "none"}${f.reducedMotion ? "   (reduced motion: static)" : ""}`,
    `overlays  ${f.overlays.length ? f.overlays.map((o) => `${o.name} ${fixed(o.opacity, 3)}`).join("   ") : "none"}`,
  ];
  if (!f.join && join) lines.push(`          (story: ${join.window.type} ${join.window.from.id} > ${join.window.to.id} t ${fixed(join.t, 3)})`);
  lines.push(`anchor    ${anchor}`);
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

const f3 = (n: number) => Number(n.toFixed(3));

export function Hud({ story }: { story: Story }) {
  const engine = useStageEngine();
  const hudRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const rowsRef = useRef<HTMLTableSectionElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(PICKER_HINT);
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
    if (textRef.current && engine) {
      const hold = engine.params.join ? `?join=${engine.params.join} t=${engine.params.t ?? 0.5}` : "?p";
      textRef.current.textContent = readout(f, engine.stats(), m.fps, anchorRef.current, hold);
    }
    for (const row of rowsRef.current?.rows ?? []) {
      row.toggleAttribute("data-current", row.dataset.id === f.chapter.id);
    }
  });

  // The anchor picker: a press and release on the picture (not on the HUD itself).
  useEffect(() => {
    if (!engine) return;
    let start: Point | null = null;
    const onHud = (e: PointerEvent) => e.target instanceof Node && hudRef.current?.contains(e.target) === true;

    const down = (e: PointerEvent) => {
      start = e.button === 0 && !onHud(e) ? { x: e.clientX, y: e.clientY } : null;
    };
    const up = (e: PointerEvent) => {
      if (!start || e.button !== 0) return;
      const from = start;
      start = null;
      const to = { x: e.clientX, y: e.clientY };
      const f = engine.frame;
      const shown = f?.shown;
      if (!f || !shown || f.width <= 0 || f.height <= 0) return;

      // The frame on screen and its cover fit, so the click maps back into frame coordinates.
      const chapter = f.story.chapters.find((c) => c.clip === shown.a.clip) ?? f.chapter;
      const fit = coverFit(f.width, f.height, shown.a.width, shown.a.height, focalFor(chapter, f.width, f.height));
      const a = screenToFrame({ x: from.x / f.width, y: from.y / f.height }, fit);
      const b = screenToFrame({ x: to.x / f.width, y: to.y / f.height }, fit);
      const where = `${shown.a.clip} ${file(shown.a.index)}`;
      const marker = markerRef.current;

      if (Math.hypot(to.x - from.x, to.y - from.y) < DRAG_PX) {
        const snippet = `{ x: ${f3(b.x)}, y: ${f3(b.y)} }`;
        anchorRef.current = `${where}   pupil: ${snippet}   screen ${fixed(to.x / f.width, 3)}, ${fixed(to.y / f.height, 3)}`;
        console.log(`Homeward anchor on ${where}: ${snippet}`);
        if (marker) {
          marker.hidden = false;
          marker.dataset.shape = "point";
          marker.style.left = `${to.x}px`;
          marker.style.top = `${to.y}px`;
          marker.style.width = "";
          marker.style.height = "";
        }
      } else {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const snippet = `{ x: ${f3(x)}, y: ${f3(y)}, w: ${f3(Math.abs(b.x - a.x))}, h: ${f3(Math.abs(b.y - a.y))} }`;
        anchorRef.current = `${where}   photoRect: ${snippet}`;
        console.log(`Homeward anchor on ${where}: ${snippet}`);
        if (marker) {
          marker.hidden = false;
          marker.dataset.shape = "rect";
          marker.style.left = `${Math.min(from.x, to.x)}px`;
          marker.style.top = `${Math.min(from.y, to.y)}px`;
          marker.style.width = `${Math.abs(to.x - from.x)}px`;
          marker.style.height = `${Math.abs(to.y - from.y)}px`;
        }
      }
      engine.wake(); // one more frame, so the readout shows it even at rest
    };

    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
    };
  }, [engine]);

  return (
    <>
      <div ref={markerRef} className={styles.marker} hidden aria-hidden="true" />
      <aside ref={hudRef} className={styles.hud} aria-label="Developer HUD">
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
                <th>anchor</th>
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
                  <td>
                    {c.anchors.pupil
                      ? `pupil ${c.anchors.pupil.x}, ${c.anchors.pupil.y}`
                      : c.anchors.photoRect
                        ? `photo ${c.anchors.photoRect.x}, ${c.anchors.photoRect.y} ${c.anchors.photoRect.w}x${c.anchors.photoRect.h}`
                        : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.note}>
            film ends at p {story.filmEndP.toFixed(4)}, {story.totalVh} vh in all
            {story.skipped.length ? `, skipped: ${story.skipped.join(", ")}` : ""}
            {" · "}hold a join with ?join=&lt;chapter id&gt;&amp;t=0..1 (and ?v=&lt;vh/s&gt; for its speed terms)
          </p>
        </details>
        <details className={styles.section}>
          <summary>tune</summary>
          <pre className={styles.tune}>{JSON.stringify(tune, null, 2)}</pre>
        </details>
      </aside>
    </>
  );
}
