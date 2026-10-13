import { audioPath, bedAmbience, tune, type Story, type StoryChapter } from "@/content/story";

/**
 * The sound engine: WebAudio, one ambience loop per chapter plus a music bed under everything.
 *
 * Which loop is audible is a function of the chapter chapterAt(p) names (setChapter): that loop
 * crossfades in over tune.sound.crossfadeS, equal-power, while the others fade out and are stopped. The
 * bed plays under all of it. Everything runs through one master gain.
 *
 * Nothing makes a sound until the visitor asks: the AudioContext is only created inside
 * setEnabled(true), which the sound toggle calls from a click or key press. The master gain is ramped
 * to tune.sound.volume on, and back to zero off; the context is suspended while sound is off and while
 * the tab is hidden. A file that is missing (or fails to decode) is skipped silently: its loop is
 * simply never heard. Files are listed in /audio/manifest.json (written by npm run audio), so the
 * engine never asks for one that is not there.
 */

type LoopState = "idle" | "loading" | "ready" | "missing";

interface Loop {
  id: string;
  state: LoopState;
  buffer: AudioBuffer | null;
  gain: GainNode | null;
  source: AudioBufferSourceNode | null;
  /** Level this loop is heading for (0 = fading out or silent). */
  target: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

export interface SoundStats {
  enabled: boolean;
  context: AudioContextState | "none";
  /** Chapter loop that is audible now. */
  current: string | null;
  master: number;
  loops: { id: string; state: LoopState; playing: boolean; target: number; level: number }[];
}

/** Segments a fade is cut into: linear ramps approximating an equal-power curve. */
const FADE_STEPS = 12;

type AudioContextCtor = typeof AudioContext;

function contextClass(): AudioContextCtor | null {
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

export function soundSupported(): boolean {
  return typeof window !== "undefined" && contextClass() !== null;
}

/** Formats in the order to try them: the ones this browser says it can play first. */
function formatOrder(): readonly (typeof tune.sound.formats)[number][] {
  const probe = document.createElement("audio");
  const mime = { m4a: 'audio/mp4; codecs="mp4a.40.2"', ogg: 'audio/ogg; codecs="vorbis"' } as const;
  const playable = (f: (typeof tune.sound.formats)[number]) => probe.canPlayType(mime[f]) !== "";
  return [...tune.sound.formats].sort((a, b) => Number(playable(b)) - Number(playable(a)));
}

export class SoundEngine {
  enabled = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private loops = new Map<string, Loop>();
  private files: Set<string> | null = null;
  private filesLoading: Promise<void> | null = null;
  private chapter: StoryChapter | null = null;
  private story: Story | null = null;
  private hidden = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** Call once on the client: pauses sound while the tab is hidden. Returns the function that undoes it. */
  attach(): () => void {
    this.disposed = false;
    const onVisibility = () => {
      this.hidden = document.visibilityState === "hidden";
      this.syncMaster();
    };
    this.hidden = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      this.disposed = true;
      for (const loop of this.loops.values()) if (loop.stopTimer) clearTimeout(loop.stopTimer);
      if (this.suspendTimer) clearTimeout(this.suspendTimer);
      void this.ctx?.close().catch(() => {});
      this.ctx = null;
      this.master = null;
      this.loops.clear();
      this.enabled = false;
    };
  }

  /** The chapter chapterAt(p) names. Cheap to call on every stage frame: it only acts when the chapter changes. */
  setChapter(chapter: StoryChapter, story: Story) {
    if (chapter === this.chapter && story === this.story) return;
    this.chapter = chapter;
    this.story = story;
    if (this.ctx) this.apply();
  }

  /** Turn sound on or off. Turning on must come from a user gesture. */
  async setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      const Ctx = contextClass();
      if (!Ctx) {
        this.enabled = false;
        return;
      }
      if (!this.ctx) {
        const ctx = new Ctx();
        const master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);
        this.ctx = ctx;
        this.master = master;
      }
      this.syncMaster();
      this.apply();
    } else {
      this.syncMaster();
    }
  }

  stats(): SoundStats {
    return {
      enabled: this.enabled,
      context: this.ctx?.state ?? "none",
      current: this.chapter?.ambience ?? null,
      master: this.master?.gain.value ?? 0,
      loops: [...this.loops.values()].map((l) => ({
        id: l.id,
        state: l.state,
        playing: l.source !== null,
        target: l.target,
        level: l.gain?.gain.value ?? 0,
      })),
    };
  }

  /** Master gain and context state follow "on and the tab visible". */
  private syncMaster() {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    const audible = this.enabled && !this.hidden;
    const ramp = tune.sound.masterRampS;
    if (audible) {
      void ctx.resume().catch(() => {});
      this.ramp(master.gain, tune.sound.volume, ramp, false);
    } else {
      this.ramp(master.gain, 0, ramp, false);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (!(this.enabled && !this.hidden)) void ctx.suspend().catch(() => {});
      }, ramp * 1000 + 50);
    }
  }

  /** Ramp a parameter from where it is to `to` over `seconds`: equal-power for the loops, linear for the master. */
  private ramp(param: AudioParam, to: number, seconds: number, equalPower: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const from = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
    if (!equalPower || seconds <= 0) {
      param.linearRampToValueAtTime(to, now + Math.max(seconds, 0.001));
      return;
    }
    for (let i = 1; i <= FADE_STEPS; i++) {
      const x = i / FADE_STEPS;
      // Rising: sine quarter. Falling: cosine quarter.
      const shape = to >= from ? Math.sin((x * Math.PI) / 2) : 1 - Math.cos((x * Math.PI) / 2);
      param.linearRampToValueAtTime(from + (to - from) * shape, now + x * seconds);
    }
  }

  /** Bring the loops in line with the current chapter: fetch what is near, fade in the one that is current, fade out the rest. */
  private apply() {
    const ctx = this.ctx;
    const chapter = this.chapter;
    const story = this.story;
    if (!ctx || !chapter || !story || !this.enabled) return;

    const ahead = story.chapters.slice(chapter.index + 1, chapter.index + 1 + tune.sound.preloadAhead).map((c) => c.ambience);
    const wanted = new Map<string, number>([[bedAmbience, tune.sound.bedGain]]);
    wanted.set(chapter.ambience, tune.sound.ambienceGain);
    for (const id of ahead) if (!wanted.has(id)) wanted.set(id, 0);

    for (const [id, level] of wanted) {
      const loop = this.loop(id);
      loop.target = level;
      if (loop.state === "idle") void this.load(loop);
    }
    for (const loop of this.loops.values()) {
      if (!wanted.has(loop.id)) loop.target = 0;
      this.drive(loop);
    }
  }

  private loop(id: string): Loop {
    let loop = this.loops.get(id);
    if (!loop) {
      loop = { id, state: "idle", buffer: null, gain: null, source: null, target: 0, stopTimer: null };
      this.loops.set(id, loop);
    }
    return loop;
  }

  /** Start, fade or stop one loop towards its target. */
  private drive(loop: Loop) {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || loop.state !== "ready" || !loop.buffer) return;
    const fade = tune.sound.crossfadeS;

    if (loop.target > 0) {
      if (loop.stopTimer) {
        clearTimeout(loop.stopTimer);
        loop.stopTimer = null;
      }
      if (!loop.source || !loop.gain) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(master);
        const source = ctx.createBufferSource();
        source.buffer = loop.buffer;
        source.loop = true;
        source.connect(gain);
        source.start();
        loop.gain = gain;
        loop.source = source;
      }
      this.ramp(loop.gain.gain, loop.target, fade, true);
    } else if (loop.source && loop.gain && !loop.stopTimer) {
      this.ramp(loop.gain.gain, 0, fade, true);
      loop.stopTimer = setTimeout(() => {
        loop.stopTimer = null;
        if (loop.target > 0) return;
        try {
          loop.source?.stop();
        } catch {
          // already stopped
        }
        loop.source?.disconnect();
        loop.gain?.disconnect();
        loop.source = null;
        loop.gain = null;
      }, (fade + tune.sound.stopAfterS) * 1000);
    }
  }

  /** The list of files in /audio/, read once. A missing list means no sound files at all. */
  private async fileList(): Promise<Set<string>> {
    if (!this.filesLoading) {
      this.filesLoading = fetch("/audio/manifest.json")
        .then((r) => (r.ok ? (r.json() as Promise<{ files?: unknown }>) : null))
        .then((j) => {
          const files = j && Array.isArray(j.files) ? j.files.filter((f): f is string => typeof f === "string") : [];
          this.files = new Set(files);
        })
        .catch(() => {
          this.files = new Set();
        });
    }
    await this.filesLoading;
    return this.files ?? new Set();
  }

  private async load(loop: Loop) {
    loop.state = "loading";
    try {
      const files = await this.fileList();
      for (const format of formatOrder()) {
        if (!files.has(`${loop.id}.${format}`)) continue;
        try {
          const response = await fetch(audioPath(loop.id, format));
          if (!response.ok) continue;
          const data = await response.arrayBuffer();
          const ctx = this.ctx;
          if (!ctx || this.disposed) break;
          loop.buffer = await new Promise<AudioBuffer>((resolve, reject) => {
            // The callback form works in every browser that has WebAudio.
            ctx.decodeAudioData(data, resolve, (error) => reject(error ?? new Error("decode failed")));
          });
          break;
        } catch {
          // Try the next format.
        }
      }
    } catch {
      // Fall through: the loop stays missing.
    }
    loop.state = loop.buffer ? "ready" : "missing";
    if (loop.state === "ready" && !this.disposed) this.drive(loop);
  }
}
