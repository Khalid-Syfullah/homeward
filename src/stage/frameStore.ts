import {
  chapterAt,
  chapters as allChapters,
  frameUrl,
  localT,
  localTOf,
  manifestPath,
  tune,
  type Story,
  type StoryChapter,
  type Tier,
} from "@/content/story";
import { isPhoneViewport } from "./fit";

/**
 * The frame store: decoded frames for the chapter playing now plus a lookahead of
 * tune.lookaheadChapters chapters in the direction of travel (and tune.behindChapters behind it),
 * loaded nearest-first by their distance in p from the playhead.
 *
 * Two layers, both capped and evicted least-recently-used:
 *   - decoded ImageBitmaps (what the compositor uploads), capped at tune.memoryCapMb. At the 1440
 *     tier a frame is about 4.5 MB decoded, so the cap holds a window of frames around the
 *     playhead rather than whole chapters;
 *   - the encoded WebP bytes (about 90 KB a frame), capped at tune.blobCapMb, which do hold the
 *     current chapter and the lookahead, so a frame that was evicted decodes again without the
 *     network.
 * Every plan orders the wanted frames by distance; the prefix that fits each cap is kept, fetches
 * nobody wants any more are aborted, and only frames outside the kept prefix are ever evicted.
 *
 * Frames are only requested for clips with a manifest.json (written by npm run placeholders and
 * npm run art:import): it gives the real frame count per tier and a fingerprint, which goes on the
 * frame URLs so re-imported frames are never served from a stale cache. The server inlines the
 * manifests in the page (seed), so the first frames are requested without waiting for them; they are
 * read again from the network once the first paint is in (at once in development, where frames change).
 *
 * First paint (tune.firstPaint, docs/PERF.md): until it is in, a plan holds only the tune.firstPaint.frames
 * frames nearest the playhead, at the narrowest tier, plus the frame or pair on screen at the playing
 * tier, requested at high priority. That keeps the first-paint payload small on every connection; the
 * narrow frames then stand in (still blended in pairs) until the playing tier replaces them.
 */

export const MB = 1024 * 1024;
const WIDEST: Tier = tune.tiers[0];
const NARROWEST: Tier = tune.tiers[tune.tiers.length - 1];
const BYTES_PER_PIXEL = 4;

export type FrameImage = ImageBitmap | HTMLImageElement;

export interface TierInfo {
  count: number;
  width: number;
  height: number;
}

export interface ClipManifest {
  clip: string;
  /** Fingerprint of the frames; it changes when they are generated or imported again. */
  version: string;
  placeholder: boolean;
  tiers: Partial<Record<number, TierInfo>>;
}

/** A decoded frame. */
export interface Frame {
  key: string;
  clip: string;
  tier: number;
  version: string;
  index: number;
  /** Frames in this clip's tier (the index runs 0 .. count-1). */
  count: number;
  image: FrameImage;
  width: number;
  height: number;
  bytes: number;
  /** Last time it was drawn or decoded (performance.now()), for LRU eviction. */
  used: number;
}

/** What to draw: a blended by mix (0..1) into b. */
export interface FramePick {
  a: Frame;
  b: Frame;
  mix: number;
  /** a and b are the wanted floor and ceil frames; false when a nearest loaded frame stands in. */
  exact: boolean;
}

export interface StoreStats {
  tier: Tier;
  tierReason: string;
  /** Whether the first-paint frames are in (until then a plan holds only them). */
  firstPaint: boolean;
  decodedBytes: number;
  capBytes: number;
  frames: number;
  encodedBytes: number;
  encodedCapBytes: number;
  encoded: number;
  fetching: number;
  decoding: number;
  failed: number;
  /** Frames in the decoded and encoded keep sets of the current plan. */
  planned: number;
  prefetch: number;
  manifests: number;
}

interface Encoded {
  blob: Blob;
  bytes: number;
  used: number;
}

interface Want {
  key: string;
  clip: string;
  tier: number;
  version: string;
  index: number;
  count: number;
  url: string;
  /** Distance in p from the playhead (weighted by tune.behindBias behind the direction of travel). */
  dist: number;
  /** Decoded size in bytes. */
  bytes: number;
  /** Fetched at high priority (the first-paint frames). */
  urgent: boolean;
}

interface Failure {
  at: number;
  tries: number;
}

const now = () => performance.now();

function release(image: FrameImage) {
  if ("close" in image) image.close();
}

function imageSize(image: FrameImage) {
  return "naturalWidth" in image
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
}

async function decodeImage(blob: Blob): Promise<FrameImage> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  // Very old browsers: decode through an <img>, which WebGL and 2D canvases accept too.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Wait before trying a failed load again: tune.retryMs, doubling per try. */
function retryDelay(tries: number) {
  return tune.retryMs * 2 ** Math.max(0, tries - 1);
}

/** A user timing mark for scripts/perf.mjs and the browser's performance panel. */
export function markTiming(name: string) {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") performance.mark(name);
}

/** A manifest.json (as written by the placeholders and art:import) in the shape the store keeps. */
export function parseManifest(clip: string, raw: unknown): ClipManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as { fingerprint?: unknown; placeholder?: unknown; tiers?: unknown };
  const tiers: Partial<Record<number, TierInfo>> = {};
  if (m.tiers && typeof m.tiers === "object") {
    for (const [name, value] of Object.entries(m.tiers as Record<string, unknown>)) {
      const tier = Number(name);
      const info = (value ?? {}) as { count?: unknown; width?: unknown; height?: unknown };
      if (!Number.isFinite(tier) || typeof info.count !== "number" || info.count < 1) continue;
      tiers[tier] = {
        count: Math.floor(info.count),
        width: typeof info.width === "number" ? info.width : tier,
        height: typeof info.height === "number" ? info.height : Math.round(tier / tune.frameAspect),
      };
    }
  }
  return {
    clip,
    version: typeof m.fingerprint === "string" ? m.fingerprint : "",
    placeholder: m.placeholder === true,
    tiers,
  };
}

interface NavigatorHints {
  connection?: { effectiveType?: string; saveData?: boolean };
  deviceMemory?: number;
}

/**
 * The tier to load: the 768 tier on phones, slow connections (or save-data) and when memory is
 * tight (low device memory, or a cap that holds fewer than tune.minDecodedFrames wide frames).
 */
export function chooseTier(cssWidth: number, cssHeight: number, capBytes: number, override: Tier | null): { tier: Tier; reason: string } {
  if (override) return { tier: override, reason: "?tier" };
  if (isPhoneViewport(cssWidth, cssHeight)) return { tier: NARROWEST, reason: "phone" };
  const nav = (typeof navigator === "undefined" ? {} : navigator) as NavigatorHints;
  const conn = nav.connection;
  if (conn?.saveData) return { tier: NARROWEST, reason: "save-data" };
  if (conn?.effectiveType && (tune.slowConnections as readonly string[]).includes(conn.effectiveType)) {
    return { tier: NARROWEST, reason: `slow connection (${conn.effectiveType})` };
  }
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= tune.lowMemoryGb) {
    return { tier: NARROWEST, reason: `device memory ${nav.deviceMemory} GB` };
  }
  const wideFrame = WIDEST * Math.round(WIDEST / tune.frameAspect) * BYTES_PER_PIXEL;
  if (capBytes < tune.minDecodedFrames * wideFrame) return { tier: NARROWEST, reason: "memory cap" };
  return { tier: WIDEST, reason: "desktop" };
}

export class FrameStore {
  tier: Tier = WIDEST;
  tierReason = "desktop";
  capBytes = tune.memoryCapMb * MB;
  readonly encodedCapBytes = tune.blobCapMb * MB;

  private manifests = new Map<string, ClipManifest | null>();
  private manifestEpoch = 0;
  private manifestFailures = new Map<string, number>();
  private manifestController: AbortController | null = null;
  private lastManifestLoad = -Infinity;

  private frames = new Map<string, Frame>();
  private encoded = new Map<string, Encoded>();
  private decodedBytes = 0;
  private encodedBytes = 0;

  private fetches = new Map<string, AbortController>();
  private decodes = new Set<string>();
  private failed = new Map<string, Failure>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  /** The current plan: wanted frames nearest first, and the keys kept decoded and encoded. */
  private wants: Want[] = [];
  private planned = 0;
  private decodeSet = new Set<string>();
  private encodedSet = new Set<string>();
  private planKey = "";
  private planStory: Story | null = null;
  private storyClips = new WeakMap<Story, Map<string, StoryChapter>>();

  /** The manifests came inlined in the page; they are read from the network again after the first paint. */
  private seeded = false;
  /** First paint: done once every frame of the latest first-paint plan has loaded (or failed for good). */
  private firstPaintDone = false;
  private firstPaintKeys = new Set<string>();

  private disposed = false;

  /** onFrame runs when a new frame is decoded or a manifest changes (something new to draw). */
  constructor(private readonly onFrame: () => void) {}

  /**
   * Manifests known before any request (the server inlines them in the page), by clip; null for a clip
   * with no frames on disk. Call before start().
   */
  seed(manifests: Readonly<Record<string, unknown>>) {
    for (const [clip, raw] of Object.entries(manifests)) {
      if (!this.manifests.has(clip)) this.manifests.set(clip, raw === null ? null : parseManifest(clip, raw));
    }
    // With no frames at all the first paint can never come in, so then the network is asked at once.
    this.seeded = [...this.manifests.values()].some((m) => m !== null);
    this.manifestEpoch++;
  }

  start() {
    // In production the inlined manifests are what the build saw: read them again once the first paint
    // is in, so the first frames never wait behind them. In development frames change all the time.
    if (!this.seeded || process.env.NODE_ENV !== "production") this.loadManifests();
  }

  dispose() {
    this.disposed = true;
    this.manifestController?.abort();
    for (const controller of this.fetches.values()) controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    for (const frame of this.frames.values()) release(frame.image);
    this.fetches.clear();
    this.timers.clear();
    this.frames.clear();
    this.encoded.clear();
    this.decodedBytes = 0;
    this.encodedBytes = 0;
    this.wants = [];
  }

  // ---------- manifests ----------

  /** Read every clip's manifest again (development: frames may have been imported meanwhile). */
  recheckManifests() {
    if (now() - this.lastManifestLoad >= tune.manifestRecheckMs) this.loadManifests();
  }

  private loadManifests() {
    this.manifestController?.abort();
    const controller = new AbortController();
    this.manifestController = controller;
    this.lastManifestLoad = now();
    for (const c of allChapters) this.loadManifest(c.clip, controller);
  }

  private loadManifest(clip: string, controller: AbortController) {
    fetch(manifestPath(clip), { cache: "no-store", signal: controller.signal })
      .then(async (r) => {
        if (r.ok) return parseManifest(clip, await r.json());
        if (r.status === 404) return null;
        throw new Error(`HTTP ${r.status}`);
      })
      .then(
        (manifest) => {
          this.manifestFailures.delete(clip);
          this.setManifest(clip, manifest);
        },
        () => {
          if (controller.signal.aborted || this.disposed) return;
          // A network error: keep what we had; with nothing yet, try again a few times.
          const tries = (this.manifestFailures.get(clip) ?? 0) + 1;
          this.manifestFailures.set(clip, tries);
          if (this.manifests.has(clip)) return;
          if (tries > tune.maxRetries) {
            this.setManifest(clip, null);
            return;
          }
          this.later(retryDelay(tries), () => {
            if (this.manifestController === controller) this.loadManifest(clip, controller);
          });
        },
      );
  }

  private setManifest(clip: string, manifest: ClipManifest | null) {
    if (this.disposed) return;
    const old = this.manifests.get(clip);
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(manifest)) return;
    this.manifests.set(clip, manifest);
    // New or changed frames: failed loads of this clip get a fresh start.
    for (const key of [...this.failed.keys()]) if (key.startsWith(`${clip}/`)) this.failed.delete(key);
    this.manifestEpoch++;
    this.onFrame();
  }

  /** The tier this clip is loaded at: the store's tier, or another one its manifest has. */
  private clipTier(clip: string): number {
    return this.tierOf(clip, this.tier);
  }

  /** `wanted` if the clip's manifest has that tier, else the first tier it has. */
  private tierOf(clip: string, wanted: number): number {
    const manifest = this.manifests.get(clip);
    if (!manifest || manifest.tiers[wanted]) return wanted;
    return tune.tiers.find((t) => manifest.tiers[t]) ?? wanted;
  }

  private tierInfo(clip: string, tier: number, fallbackCount: number): TierInfo {
    return (
      this.manifests.get(clip)?.tiers[tier] ?? {
        count: fallbackCount,
        width: tier,
        height: Math.round(tier / tune.frameAspect),
      }
    );
  }

  /** Frames in the chapter's clip at the tier being loaded (the manifest's count, else story.ts). */
  countFor(chapter: StoryChapter): number {
    return this.tierInfo(chapter.clip, this.clipTier(chapter.clip), chapter.frames).count;
  }

  /** Pixel size of the chapter's frames at the tier being loaded. */
  frameSize(chapter: StoryChapter): { width: number; height: number } {
    const { width, height } = this.tierInfo(chapter.clip, this.clipTier(chapter.clip), chapter.frames);
    return { width, height };
  }

  /** Whether the clip's manifest has been read (null inside: it has none). */
  manifest(clip: string): ClipManifest | null | undefined {
    return this.manifests.get(clip);
  }

  private key(clip: string, tier: number, version: string, index: number) {
    return `${clip}/${tier}/${index}@${version}`;
  }

  // ---------- planning and loading ----------

  setTier(tier: Tier, reason: string) {
    this.tierReason = reason;
    if (tier === this.tier) return;
    this.tier = tier;
    this.planKey = "";
  }

  setCap(bytes: number) {
    if (bytes === this.capBytes) return;
    this.capBytes = bytes;
    this.planKey = "";
  }

  /** Plan the loads for the playhead at p moving in direction, and start what fits. */
  update(p: number, direction: 1 | -1, story: Story) {
    if (this.disposed) return;
    const chapter = chapterAt(p, story);
    const count = this.countFor(chapter);
    const index = Math.round(localT(p, story) * (count - 1));
    const key = `${chapter.id}|${index}|${direction}|${this.tier}|${this.capBytes}|${this.manifestEpoch}|${this.firstPaintDone}`;
    if (key !== this.planKey || story !== this.planStory) {
      this.planKey = key;
      this.planStory = story;
      this.plan(p, direction, story, chapter);
    }
    this.pump();
  }

  private plan(p: number, direction: 1 | -1, story: Story, current: StoryChapter) {
    const list = story.chapters;
    const picked: StoryChapter[] = [current];
    for (let k = 1; k <= tune.lookaheadChapters; k++) {
      const c = list[current.index + direction * k];
      if (c) picked.push(c);
    }
    for (let k = 1; k <= tune.behindChapters; k++) {
      const c = list[current.index - direction * k];
      if (c) picked.push(c);
    }

    const first = !this.firstPaintDone;
    const wants: Want[] = [];
    for (const c of picked) {
      const manifest = this.manifests.get(c.clip);
      if (!manifest) continue; // not read yet, or no frames on disk
      const tier = first ? this.tierOf(c.clip, NARROWEST) : this.clipTier(c.clip);
      const info = this.tierInfo(c.clip, tier, c.frames);
      const span = c.endP - c.startP;
      for (let i = 0; i < info.count; i++) {
        const at = c.startP + (info.count > 1 ? i / (info.count - 1) : 0) * span;
        const delta = at - p;
        wants.push(this.want(c.clip, tier, manifest, i, info, Math.abs(delta) * (delta * direction < 0 ? tune.behindBias : 1), first));
      }
    }
    wants.sort((x, y) => x.dist - y.dist);

    if (first) {
      // First paint: the nearest frames at the narrow tier, led by the picture on screen at the tier the
      // device plays (the loading frame the page shows already, so the browser has it cached).
      wants.length = Math.min(wants.length, tune.firstPaint.frames);
      const manifest = this.manifests.get(current.clip);
      const playing = this.clipTier(current.clip);
      if (manifest && playing !== this.tierOf(current.clip, NARROWEST)) {
        const info = this.tierInfo(current.clip, playing, current.frames);
        const f = localTOf(current, p, story) * (info.count - 1);
        const i0 = Math.floor(f);
        const shown = f > i0 ? [i0, Math.min(i0 + 1, info.count - 1)] : [i0];
        wants.unshift(...shown.map((i) => this.want(current.clip, playing, manifest, i, info, 0, true)));
      }
      this.firstPaintKeys = new Set(wants.map((w) => w.key));
    }

    // The nearest prefix that fits each cap (the floor and ceil frames always count).
    const decodeSet = new Set<string>();
    const encodedSet = new Set<string>();
    let decoded = 0;
    let encoded = 0;
    let decodeOpen = true;
    let encodedOpen = true;
    for (let i = 0; i < wants.length && (decodeOpen || encodedOpen); i++) {
      const w = wants[i];
      if (decodeOpen) {
        if (decoded + w.bytes <= this.capBytes || i < 2) {
          decoded += w.bytes;
          decodeSet.add(w.key);
        } else decodeOpen = false;
      }
      if (encodedOpen) {
        const size = this.encoded.get(w.key)?.bytes ?? tune.frameKb[w.tier as Tier] * 1024;
        if (encoded + size <= this.encodedCapBytes || i < 2) {
          encoded += size;
          encodedSet.add(w.key);
        } else encodedOpen = false;
      }
    }

    this.wants = wants;
    this.planned = Math.max(decodeSet.size, encodedSet.size);
    this.decodeSet = decodeSet;
    this.encodedSet = encodedSet;

    // Stale loads: abort fetches that nobody wants any more.
    for (const [key, controller] of this.fetches) {
      if (!decodeSet.has(key) && !encodedSet.has(key)) controller.abort();
    }
  }

  private want(clip: string, tier: number, manifest: ClipManifest, index: number, info: TierInfo, dist: number, urgent: boolean): Want {
    return {
      key: this.key(clip, tier, manifest.version, index),
      clip,
      tier,
      version: manifest.version,
      index,
      count: info.count,
      url: frameUrl(clip, tier, index, manifest.version),
      dist,
      bytes: info.width * info.height * BYTES_PER_PIXEL,
      urgent,
    };
  }

  /**
   * The first paint is in once every frame of its latest plan has loaded or failed (a failed one is tried
   * again later, but it does not hold the rest back). Then the store plans at the playing tier, and reads
   * the inlined manifests again from the network.
   */
  private checkFirstPaint() {
    if (this.firstPaintDone || this.disposed || this.firstPaintKeys.size === 0) return;
    for (const key of this.firstPaintKeys) {
      if (!this.frames.has(key) && !this.failed.has(key)) return;
    }
    this.firstPaintDone = true;
    this.firstPaintKeys.clear();
    this.planKey = "";
    markTiming("homeward:first-paint");
    if (this.seeded && process.env.NODE_ENV === "production") this.loadManifests();
    this.onFrame();
  }

  /** Start fetches and decodes, nearest first, up to tune.maxFetches and tune.maxDecodes. */
  private pump() {
    if (this.disposed) return;
    const t = now();
    for (let i = 0; i < this.planned; i++) {
      const fetchFull = this.fetches.size >= tune.maxFetches;
      const decodeFull = this.decodes.size >= tune.maxDecodes;
      if (fetchFull && decodeFull) break;
      const w = this.wants[i];
      if (this.frames.has(w.key) || this.fetches.has(w.key) || this.decodes.has(w.key)) continue;
      const failure = this.failed.get(w.key);
      if (failure && (failure.tries > tune.maxRetries || t - failure.at < retryDelay(failure.tries))) continue;
      const decode = this.decodeSet.has(w.key);
      const blob = this.encoded.get(w.key);
      if (blob) {
        if (decode && !decodeFull) this.startDecode(w, blob);
      } else if ((decode || this.encodedSet.has(w.key)) && !fetchFull) {
        this.startFetch(w);
      }
    }
  }

  private startFetch(w: Want) {
    const controller = new AbortController();
    this.fetches.set(w.key, controller);
    fetch(w.url, { signal: controller.signal, priority: w.urgent ? "high" : "auto" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(
        (blob) => {
          if (!controller.signal.aborted && !this.disposed) this.putEncoded(w.key, blob);
        },
        () => {
          if (!controller.signal.aborted) this.fail(w.key);
        },
      )
      .finally(() => {
        if (this.fetches.get(w.key) === controller) this.fetches.delete(w.key);
        this.pump();
      });
  }

  private startDecode(w: Want, enc: Encoded) {
    this.decodes.add(w.key);
    enc.used = now();
    decodeImage(enc.blob)
      .then(
        (image) => {
          if (this.disposed) {
            release(image);
            return;
          }
          this.putFrame(w, image);
          this.onFrame();
          this.checkFirstPaint();
        },
        () => {
          // Bad data: drop the bytes so the next try fetches them again.
          this.dropEncoded(w.key);
          this.fail(w.key);
        },
      )
      .finally(() => {
        this.decodes.delete(w.key);
        this.pump();
      });
  }

  private fail(key: string) {
    if (this.disposed) return;
    const tries = (this.failed.get(key)?.tries ?? 0) + 1;
    this.failed.set(key, { at: now(), tries });
    if (tries <= tune.maxRetries) this.later(retryDelay(tries), () => this.pump());
    this.checkFirstPaint();
  }

  private later(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) run();
    }, ms);
    this.timers.add(timer);
  }

  private putEncoded(key: string, blob: Blob) {
    const old = this.encoded.get(key);
    if (old) this.encodedBytes -= old.bytes;
    this.encoded.set(key, { blob, bytes: blob.size, used: now() });
    this.encodedBytes += blob.size;
    // Least recently used first, never anything the current plan keeps.
    while (this.encodedBytes > this.encodedCapBytes) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [k, e] of this.encoded) {
        if (this.encodedSet.has(k) || this.decodeSet.has(k)) continue;
        if (e.used < oldest) {
          oldest = e.used;
          victim = k;
        }
      }
      if (victim === null) break;
      this.dropEncoded(victim);
    }
  }

  private dropEncoded(key: string) {
    const e = this.encoded.get(key);
    if (!e) return;
    this.encodedBytes -= e.bytes;
    this.encoded.delete(key);
  }

  private putFrame(w: Want, image: FrameImage) {
    const { width, height } = imageSize(image);
    const old = this.frames.get(w.key);
    if (old) {
      this.decodedBytes -= old.bytes;
      release(old.image);
    }
    const bytes = width * height * BYTES_PER_PIXEL;
    this.frames.set(w.key, {
      key: w.key,
      clip: w.clip,
      tier: w.tier,
      version: w.version,
      index: w.index,
      count: w.count,
      image,
      width,
      height,
      bytes,
      used: now(),
    });
    this.decodedBytes += bytes;
    // Least recently used first, never anything the current plan keeps decoded.
    while (this.decodedBytes > this.capBytes) {
      let victim: Frame | null = null;
      for (const f of this.frames.values()) {
        if (this.decodeSet.has(f.key)) continue;
        if (!victim || f.used < victim.used) victim = f;
      }
      if (!victim) break;
      this.frames.delete(victim.key);
      this.decodedBytes -= victim.bytes;
      release(victim.image);
    }
  }

  // ---------- drawing ----------

  private clipsOf(story: Story) {
    let map = this.storyClips.get(story);
    if (!map) {
      map = new Map(story.chapters.map((c) => [c.clip, c]));
      this.storyClips.set(story, map);
    }
    return map;
  }

  /**
   * The frames to draw at p: the floor and ceil frames of the fractional frame index, blended by
   * its fraction. If either is missing, the nearest loaded frame (by its place in p, from any
   * chapter or tier) stands in. Null only before the very first frame has loaded.
   */
  pick(p: number, story: Story): FramePick | null {
    return this.pickChapter(chapterAt(p, story), p, story);
  }

  /**
   * The frames of one given chapter at p, for the two sides of a join: before the chapter starts
   * it holds its first frame, after it ends its last (story.ts localTOf). With nothing to blend (the
   * index is whole) the floor frame alone is the picture. If the wanted pair is missing at the playing
   * tier, the same pair at another tier stands in, still blended (the first-paint frames, or the tier
   * before a resize); else the chapter's own nearest loaded frame, else the nearest loaded frame of all.
   * `at` replaces the chapter's local time at p (the page flips show a smoothed, capped index).
   */
  pickChapter(chapter: StoryChapter, p: number, story: Story, at?: number): FramePick | null {
    const manifest = this.manifests.get(chapter.clip);
    const t = now();
    const local = Math.min(Math.max(at ?? localTOf(chapter, p, story), 0), 1);
    if (manifest) {
      const playing = this.clipTier(chapter.clip);
      const others = tune.tiers.filter((tier) => tier !== playing && manifest.tiers[tier]);
      for (const tier of [playing, ...others]) {
        const count = this.tierInfo(chapter.clip, tier, chapter.frames).count;
        const f = local * (count - 1);
        const i0 = Math.floor(f);
        const i1 = Math.min(i0 + 1, count - 1);
        const mix = i1 === i0 ? 0 : f - i0;
        const a = this.frames.get(this.key(chapter.clip, tier, manifest.version, i0));
        const b = mix > 0 ? this.frames.get(this.key(chapter.clip, tier, manifest.version, i1)) : a;
        if (a && b) {
          a.used = b.used = t;
          return { a, b, mix, exact: tier === playing };
        }
      }
    }

    // Nearest loaded frame: this chapter's own by its local time first, else any by its position in p;
    // the current tier and version win a tie.
    const clips = this.clipsOf(story);
    let best: Frame | null = null;
    let bestOwn = false;
    let bestDist = Infinity;
    let bestPreferred = false;
    for (const frame of this.frames.values()) {
      const c = clips.get(frame.clip);
      if (!c) continue;
      const own = frame.clip === chapter.clip;
      if (bestOwn && !own) continue;
      const share = frame.count > 1 ? frame.index / (frame.count - 1) : 0;
      const dist = own ? Math.abs(share - local) : Math.abs(c.startP + share * (c.endP - c.startP) - p);
      const preferred =
        frame.tier === this.clipTier(frame.clip) && frame.version === (this.manifests.get(frame.clip)?.version ?? "");
      if ((own && !bestOwn) || dist < bestDist || (dist === bestDist && preferred && !bestPreferred)) {
        best = frame;
        bestOwn = own;
        bestDist = dist;
        bestPreferred = preferred;
      }
    }
    if (!best) return null;
    best.used = t;
    return { a: best, b: best, mix: 0, exact: false };
  }

  /** Whether a decoded frame is still in the store (its image has not been released). */
  holds(frame: Frame): boolean {
    return this.frames.get(frame.key) === frame;
  }

  stats(): StoreStats {
    let failed = 0;
    for (const f of this.failed.values()) if (f.tries > 0) failed++;
    let manifests = 0;
    for (const m of this.manifests.values()) if (m) manifests++;
    return {
      tier: this.tier,
      tierReason: this.tierReason,
      firstPaint: this.firstPaintDone,
      decodedBytes: this.decodedBytes,
      capBytes: this.capBytes,
      frames: this.frames.size,
      encodedBytes: this.encodedBytes,
      encodedCapBytes: this.encodedCapBytes,
      encoded: this.encoded.size,
      fetching: this.fetches.size,
      decoding: this.decodes.size,
      failed,
      planned: this.decodeSet.size,
      prefetch: this.encodedSet.size,
      manifests,
    };
  }

  /** Decoded and encoded frames held for one chapter at the tier being loaded, out of its count. */
  chapterStats(chapter: StoryChapter) {
    const manifest = this.manifests.get(chapter.clip);
    const tier = this.clipTier(chapter.clip);
    const count = this.tierInfo(chapter.clip, tier, chapter.frames).count;
    let decoded = 0;
    let encoded = 0;
    if (manifest) {
      for (let i = 0; i < count; i++) {
        const key = this.key(chapter.clip, tier, manifest.version, i);
        if (this.frames.has(key)) decoded++;
        if (this.encoded.has(key)) encoded++;
      }
    }
    return { count, decoded, encoded, tier, manifest: manifest === undefined ? "loading" : manifest ? (manifest.placeholder ? "placeholder" : "real") : "none" };
  }
}
