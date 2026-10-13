/**
 * Homeward story map: the single source for chapters, clips, scroll lengths, frame counts,
 * joins, anchors, focal points, captions and ambience, plus the pure helpers that turn the
 * scroll progress p (0..1) into a chapter, a local time and a join window.
 *
 * This file must stay self-contained (no imports, plain TypeScript): the Node scripts in
 * scripts/ load it through scripts/lib/load-ts.mjs so the site and the asset pipeline share
 * one set of numbers.
 *
 * Timeline. The page scrolls through the film (the sum of every present chapter's scrollVh)
 * and then one end screen (tune.endScreenVh). p is progress over that whole scroll, so the
 * film occupies p in [0, filmVh / totalVh] and the end screen the rest. The scroll container
 * is totalVh of scroll; the sticky stage adds the one viewport it occupies itself, so p
 * reaches exactly 1 at the bottom of the page.
 */

export type JoinType = "push" | "portal" | "rect" | "none";

/** A point in 0..1 frame coordinates (x to the right, y down). */
export interface Point {
  x: number;
  y: number;
}

/** A rectangle in 0..1 frame coordinates (top-left corner plus size). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Anchors {
  /** c02: where the pupil sits on the clip's last frame; the portal join opens from here. */
  pupil?: Point;
  /** c08: where the photograph sits on the clip's last frame; the rect join grows from here. */
  photoRect?: Rect;
}

export interface Focal {
  desktop: Point;
  phone: Point;
}

export interface Caption {
  title: string;
  line: string;
}

/** A vignette state; inner and outer are distances from its centre in viewport heights. */
export interface VignetteState {
  /** 0 (none) to 1 (the vignette colour at full strength outside the outer radius). */
  strength: number;
  /** Clear inside this distance. */
  inner: number;
  /** Full strength beyond this distance. */
  outer: number;
}

/**
 * How a chapter's picture is treated on top of its frames (src/stage/looks.ts). Everything here is
 * a function of the chapter's local time t (0..1), except the breath, which also follows the clock.
 * Every look is exactly the plain frame where its terms are zero, and none of it moves under
 * reduced motion.
 */
export interface Look {
  /** Zoom across the chapter (1 = none), linear in the chapter's local time. */
  scale?: { from: number; to: number };
  /** Vertical drift across the chapter in CSS pixels (negative moves the picture up). */
  driftPx?: { from: number; to: number };
  /** Breathing while the page rests: scale 1 to 1 + amplitude on a sine of the clock. */
  breath?: { amplitude: number; periodS: number };
  /** The point scale and breath zoom about: the middle of the frame, or the pupil anchor. */
  zoomAbout?: "centre" | "pupil";
  /** A vignette that moves from one state to the other across the chapter. */
  vignette?: { color: PaletteName; toward: "centre" | "pupil"; from: VignetteState; to: VignetteState };
}

/**
 * Overlays blended over the whole picture (art/source/overlays/): mist.mp4 and dust.mp4 are looping
 * videos blended with screen, paper.webp is a tiled still blended with soft-light.
 */
export type OverlayName = "mist" | "dust" | "paper";

export interface Chapter {
  /** Chapter id, which is also the clip id and the folder under public/frames/. */
  id: string;
  /** 1-based chapter number as shown on the placeholders and in the shot list. */
  number: number;
  title: string;
  /** Clip folder under public/frames/ and file stem under art/source/clips/. */
  clip: string;
  /** Viewport heights of scroll this chapter occupies. */
  scrollVh: number;
  /** Frames kept per tier (the same count for 1440 and 768). */
  frames: number;
  /** How this chapter joins into the next present chapter. */
  join: JoinType;
  /**
   * Optional clips are skipped when their frames are missing (no manifest.json).
   * joinWhenSkipped replaces the previous chapter's join when this one is skipped.
   */
  optional?: { joinWhenSkipped: JoinType };
  /**
   * Join used instead of `join` when the next chapter is an optional one that is present.
   * c02 portals straight into c04, but when the c03 video exists it already opens the pupil
   * itself, so c02 into c03 is a plain push (docs/PLAN.md).
   */
  joinIntoOptional?: JoinType;
  anchors: Anchors;
  focal: Focal;
  caption: Caption;
  /** Per-chapter treatment of the picture (breathing, drift, vignette). */
  look?: Look;
  /** Overlays shown over this chapter; the chapters that share one share its opacity ramp (tune.overlays). */
  overlays?: readonly OverlayName[];
  /**
   * The clip's frame advance follows the scroll with a little extra smoothing and a cap on how many
   * frames one render may move (tune.pages), so a fast flick does not strobe the page flips.
   */
  pageFlip?: boolean;
  /** Ambience loop id: public/audio/<ambience>.m4a (and .ogg). */
  ambience: string;
}

/** Design tokens: the style bible palette (docs/STYLE-BIBLE.md). */
export const palette = {
  valley: "#2F5D3A",
  moss: "#6B8E4E",
  teak: "#7A4B2A",
  terracotta: "#B5573A",
  brass: "#C9A24B",
  paper: "#EFE3C8",
  sky: "#8FB8D8",
  ink: "#1E1B16",
} as const;

export type PaletteName = keyof typeof palette;

/**
 * Tunable values. Shaders and components read these instead of hard-coding numbers, and the
 * dev HUD can print them.
 */
export const tune = {
  /** Scroll length of the end screen after the film, in vh. */
  endScreenVh: 100,
  /** Length of every join window, in frames (half before the boundary, half after). */
  joinFrames: 12,
  /** Share of the join window that lies before the chapter boundary (0..1). */
  joinSplit: 0.5,
  /** Frames kept per vh of scroll; frames = round(scrollVh * framesPerVh). */
  framesPerVh: 0.6,
  /** Frame tiers written by the placeholders and art:import, widest first. */
  tiers: [1440, 768] as const,
  /** Viewports at or below this CSS width use the 768 tier. */
  phoneMaxWidth: 768,
  /** Device pixel ratio caps for the stage canvas. */
  dprCapDesktop: 1.75,
  dprCapPhone: 1.5,
  /** Aspect ratio of every frame (16:9). */
  frameAspect: 16 / 9,
  /** Chapters loaded ahead of the current one, in the direction of travel. */
  lookaheadChapters: 2,
  /** Chapters kept loaded behind the current one (for scrubbing back and the join behind). */
  behindChapters: 1,
  /** Frames behind the direction of travel count this much further away when ordering loads. */
  behindBias: 1.5,
  /** Decoded frame (ImageBitmap) memory cap, in MB (1 MB = 1024 * 1024 bytes). ?mem=<MB> overrides. */
  memoryCapMb: 160,
  /** Encoded frame bytes kept in memory, so an evicted frame decodes again without the network, in MB. */
  blobCapMb: 48,
  /** Rough encoded size of one frame per tier, in KB, used until the real size is known. */
  frameKb: { 1440: 90, 768: 35 },
  /** Frame fetches and frame decodes running at once. */
  maxFetches: 6,
  maxDecodes: 4,
  /** A failed frame or manifest load is tried again after this long (doubling each time), in ms... */
  retryMs: 3000,
  /** ...at most this many times. */
  maxRetries: 4,
  /** The 768 tier is used at or below this navigator.deviceMemory, in GB. */
  lowMemoryGb: 4,
  /** ...and when the memory cap holds fewer than this many frames of the widest tier. */
  minDecodedFrames: 24,
  /** navigator.connection.effectiveType values that get the 768 tier (as does saveData). */
  slowConnections: ["slow-2g", "2g", "3g"],
  /** Development only: manifests are read again when the tab regains focus, at most this often, in ms. */
  manifestRecheckMs: 2000,
  /** GPU textures kept for recently drawn frames (a join draws two frame pairs, plus the pair before). */
  textureCache: 8,
  /** Scroll clock: angular frequency of the critically damped spring that follows the scroll, in 1/s. */
  clockOmega: 9,
  /** The clock settles (and the render loop idles) once this close to the scroll, in p... */
  clockRestP: 0.00001,
  /** ...and this slow, in p per second. */
  clockRestVelocity: 0.0001,
  /** Longest step the clock integrates at once, in seconds (after a stall or a hidden tab). */
  clockMaxDt: 0.25,
  /** A scroll jump larger than this (in p) in one frame is a navigation, not a scrub: the clock snaps. */
  clockSnapJump: 0.2,
  /** Default focal point and anchors, in 0..1 frame coordinates. */
  defaultFocal: { x: 0.5, y: 0.5 },
  defaultPupil: { x: 0.5, y: 0.5 },
  defaultPhotoRect: { x: 0.2, y: 0.2, w: 0.6, h: 0.45 },
  /** Per-chapter looks (src/stage/looks.ts). */
  look: {
    /** Breathing is full strength below this scroll speed, in viewport heights per second... */
    breathCalmVh: 1,
    /** ...and gone at this speed and above (smoothstep between). */
    breathStillVh: 24,
  },
  /**
   * Overlays: the file under /overlays/ (copied from art/source/overlays/ by npm run overlays),
   * the opacity at the start and end of the chapters that share the overlay (linear in scroll), and how
   * it is blended. The opacity eases in over the join into the first of those chapters and out over the join
   * after the last one. A missing file is skipped silently. Videos loop and play only while visible; the
   * paper still is tiled, tileVh being the side of one tile in viewport heights.
   */
  overlays: {
    mist: { file: "mist.mp4", kind: "video", from: 0.35, to: 0, blend: "screen" },
    dust: { file: "dust.mp4", kind: "video", from: 0.25, to: 0.25, blend: "screen" },
    paper: { file: "paper.webp", kind: "image", from: 0.12, to: 0.12, blend: "soft-light", tileVh: 0.9 },
  },
  /**
   * The page flips (chapters with pageFlip, src/stage/pageFlip.ts). The displayed frame index chases the
   * scroll's frame index with an extra exponential smoothing of this angular frequency (1/s), and moves
   * at most maxFrames frames in one render, so a fast flick plays the flips one after another instead of
   * strobing. It lands exactly on the scroll's frame at rest, and follows it exactly under reduced motion.
   */
  pages: {
    smoothOmega: 22,
    maxFrames: 3,
    /** The displayed frame is snapped onto the requested one within this many frames (the smoothing never quite arrives). */
    restFrames: 0.01,
  },
  /**
   * The end panel (src/stage/EndPanel.tsx): it fades in over the end screen's scroll between these two
   * shares of it (0 at the last film frame, 1 at the bottom of the page), and takes clicks once its
   * opacity passes interactiveAt.
   */
  endPanel: {
    appearFrom: 0.12,
    appearTo: 0.4,
    interactiveAt: 0.6,
  },
  /**
   * Captions (src/stage/captionTiming.ts). A chapter's caption shows only inside its window: it fades in
   * enterVh after the previous join window ends (or the chapter starts) over enterFadeVh, and is
   * gone, fading over exitFadeVh, exitVh before its own join window starts, so it never overlaps a
   * join. On top of that the picture must have settled: scrolling slower than settleVhPerS for
   * settleMs. The caption then eases in over fadeInMs, and leaves over fadeOutMs when scrolling resumes.
   */
  captions: {
    settleVhPerS: 8,
    settleMs: 200,
    fadeInMs: 600,
    fadeOutMs: 240,
    enterVh: 3,
    enterFadeVh: 6,
    exitVh: 2,
    exitFadeVh: 6,
    /** Rise of the caption while it fades in, in CSS pixels (none under reduced motion). */
    risePx: 10,
  },
  /**
   * The three joins (src/stage/joins.ts). Every join is a pure function of its time t (0..1 over
   * the join window) and is exactly the outgoing picture at t = 0 and the incoming one at t = 1;
   * the terms marked "at full speed" grow with the absolute scroll velocity and are zero at rest.
   * Lengths are CSS pixels (the compositor scales them by the device pixel ratio).
   */
  joins: {
    /** Scroll speed, in viewport heights per second, at which the velocity terms reach full strength. */
    speedRefVh: 250,
    push: {
      /** Zoom push: the outgoing frame grows from 1 to 1 + zoom while the incoming settles from 1 + zoom to 1. */
      zoom: 0.06,
      /** Radial smear reach at full speed, mid-window, as a share of the distance from the screen centre. */
      smear: 0.035,
    },
    portal: {
      /** The incoming frame starts this much larger inside the circle and settles to 1. */
      zoom: 0.25,
      /** Feathered edge: its width at rest and the extra width at full speed. */
      feather: 22,
      featherSpeed: 44,
      /** Noise bite of the edge: amplitude at rest and the extra at full speed... */
      bite: 9,
      biteSpeed: 28,
      /** ...over this many noise cells around the circle and one cell per this many pixels outward. */
      biteCells: 18,
      biteLength: 90,
      /** The faint dark ring at the rim: its width and its strength (0..1). */
      ring: 34,
      ringStrength: 0.22,
    },
    rect: {
      /** Soft edge of the growing photograph: its width at rest and the extra width at full speed. */
      feather: 6,
      featherSpeed: 36,
      /** Join time by which the photograph's own picture has dissolved into the live incoming frame. */
      dissolveEnd: 0.45,
    },
  },
} as const;

/** A frame tier: the width in pixels of one stored frame set (public/frames/<clip>/<tier>/). */
export type Tier = (typeof tune.tiers)[number];

const centre: Focal = { desktop: { ...tune.defaultFocal }, phone: { ...tune.defaultFocal } };

/** All ten chapters in film order. */
export const chapters: readonly Chapter[] = [
  {
    id: "c01-follow",
    number: 1,
    title: "The road",
    clip: "c01-follow",
    scrollVh: 100,
    frames: 60,
    join: "push",
    anchors: {},
    focal: centre,
    caption: { title: "The road", line: "Some journeys begin with nothing but a road." },
    look: {
      scale: { from: 1, to: 1.03 },
      driftPx: { from: 0, to: -12 },
      // Warm and loose at first, closing in as the face arrives.
      vignette: {
        color: "teak",
        toward: "centre",
        from: { strength: 0.22, inner: 0.8, outer: 1.5 },
        to: { strength: 0.5, inner: 0.42, outer: 1.0 },
      },
    },
    ambience: "c01",
  },
  {
    id: "c02-eye",
    number: 2,
    title: "The eye",
    clip: "c02-eye",
    scrollVh: 70,
    frames: 42,
    join: "portal",
    joinIntoOptional: "push",
    anchors: { pupil: { ...tune.defaultPupil } },
    focal: centre,
    caption: { title: "The eye", line: "Look closer." },
    look: {
      breath: { amplitude: 0.01, periodS: 6 },
      zoomAbout: "pupil",
      // Dark, closing toward the pupil anchor so the portal opens out of the dark.
      vignette: {
        color: "ink",
        toward: "pupil",
        from: { strength: 0.25, inner: 0.95, outer: 1.7 },
        to: { strength: 0.9, inner: 0.08, outer: 0.6 },
      },
    },
    ambience: "c02",
  },
  {
    id: "c03-portal",
    number: 3,
    title: "The valley",
    clip: "c03-portal",
    scrollVh: 80,
    frames: 48,
    join: "push",
    optional: { joinWhenSkipped: "portal" },
    anchors: {},
    focal: centre,
    caption: { title: "The valley", line: "Everything you carry comes from somewhere." },
    overlays: ["mist"],
    ambience: "c03",
  },
  {
    id: "c04-descent",
    number: 4,
    title: "The way down",
    clip: "c04-descent",
    scrollVh: 130,
    frames: 78,
    join: "push",
    anchors: {},
    focal: centre,
    caption: { title: "The way down", line: "One house waits at the end of the path." },
    overlays: ["mist"],
    ambience: "c04",
  },
  {
    id: "c05-enter",
    number: 5,
    title: "The house",
    clip: "c05-enter",
    scrollVh: 100,
    frames: 60,
    join: "push",
    anchors: {},
    focal: centre,
    caption: { title: "The house", line: "It remembers every hand that built it." },
    overlays: ["dust"],
    ambience: "c05",
  },
  {
    id: "c06-book",
    number: 6,
    title: "The book",
    clip: "c06-book",
    scrollVh: 80,
    frames: 48,
    join: "push",
    anchors: {},
    focal: centre,
    caption: { title: "The book", line: "Choose one." },
    overlays: ["dust", "paper"],
    ambience: "c06",
  },
  {
    id: "c07-pages",
    number: 7,
    title: "The pages",
    clip: "c07-pages",
    scrollVh: 110,
    frames: 66,
    join: "push",
    anchors: {},
    focal: centre,
    caption: { title: "The pages", line: "Turn them as fast as you like." },
    overlays: ["dust", "paper"],
    pageFlip: true,
    ambience: "c07",
  },
  {
    id: "c08-sea-alive",
    number: 8,
    title: "The sea",
    clip: "c08-sea-alive",
    scrollVh: 100,
    frames: 60,
    // 'rect' while c08 ends inside the open book; switch to 'push' if it ends on the
    // full-frame sea (npm run art:check reports which).
    join: "rect",
    anchors: { photoRect: { ...tune.defaultPhotoRect } },
    focal: centre,
    caption: { title: "The sea", line: "The picture begins to breathe." },
    overlays: ["paper"],
    ambience: "c08",
  },
  {
    id: "c09-shore",
    number: 9,
    title: "The shore",
    clip: "c09-shore",
    scrollVh: 100,
    frames: 60,
    join: "push",
    anchors: {},
    focal: centre,
    caption: { title: "The shore", line: "People. Water. Time." },
    ambience: "c09",
  },
  {
    id: "c10-sky",
    number: 10,
    title: "The sky",
    clip: "c10-sky",
    scrollVh: 80,
    frames: 48,
    join: "none",
    anchors: {},
    focal: centre,
    caption: { title: "The sky", line: "And above all of it, this." },
    ambience: "c10",
  },
];

/**
 * The one link on the end panel, kept as a placeholder constant: replace label and href (docs/COPY.md).
 * While href is "#" the panel shows the label as plain text rather than a link that goes nowhere.
 */
export const endLink = { label: "[label]", href: "#" } as const;

/** Words around the film (docs/COPY.md). Bracketed values are placeholders to replace. */
export const site = {
  wordmark: "Homeward",
  pageTitle: "Homeward, a scroll film",
  description: "[one sentence for search and sharing]",
  end: {
    heading: "Homeward",
    line: "[one sentence about you or the project]",
    link: endLink,
  },
  sound: { on: "Sound on", off: "Sound off" },
  skip: "Skip to end",
  replay: "Replay",
} as const;

/** A chapter placed on the timeline of a resolved story. */
export interface StoryChapter extends Chapter {
  /** Position among the present chapters (0-based). */
  index: number;
  /** The join actually used into the next present chapter. */
  joinOut: JoinType;
  startVh: number;
  endVh: number;
  startP: number;
  endP: number;
}

export interface Story {
  chapters: readonly StoryChapter[];
  /** Ids of optional chapters left out because their frames are missing. */
  skipped: readonly string[];
  /** Sum of scrollVh over the present chapters. */
  filmVh: number;
  endScreenVh: number;
  /** filmVh plus the end screen: the scroll length p runs over. */
  totalVh: number;
  /** p at which the film ends and the end screen begins. */
  filmEndP: number;
}

/**
 * Resolve the story for the clips that exist. `has(clip)` answers whether a clip's frames are
 * present; only optional chapters are ever skipped (required ones fall back to placeholders).
 */
export function resolveStory(has: (clip: string) => boolean = () => true): Story {
  const present = chapters.filter((c) => !c.optional || has(c.clip));
  const skipped = chapters.filter((c) => !present.includes(c)).map((c) => c.id);
  const filmVh = present.reduce((sum, c) => sum + c.scrollVh, 0);
  const totalVh = filmVh + tune.endScreenVh;

  let at = 0;
  const placed: StoryChapter[] = present.map((c, index) => {
    const next = present[index + 1];
    let joinOut: JoinType = c.join;
    if (!next) {
      joinOut = "none";
    } else if (next.optional && c.joinIntoOptional) {
      joinOut = c.joinIntoOptional;
    } else {
      // If the chapter right after this one was skipped, its joinWhenSkipped takes over.
      const following = chapters[chapters.indexOf(c) + 1];
      if (following && following !== next && following.optional) {
        joinOut = following.optional.joinWhenSkipped;
      }
    }
    const startVh = at;
    at += c.scrollVh;
    return {
      ...c,
      index,
      joinOut,
      startVh,
      endVh: at,
      startP: startVh / totalVh,
      endP: at / totalVh,
    };
  });

  return {
    chapters: placed,
    skipped,
    filmVh,
    endScreenVh: tune.endScreenVh,
    totalVh,
    filmEndP: filmVh / totalVh,
  };
}

/** The story with every chapter present (the default until manifests say otherwise). */
export const story: Story = resolveStory();

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Cumulative scroll ranges of the present chapters, in vh and in p. */
export function ranges(s: Story = story) {
  return s.chapters.map((c) => ({
    id: c.id,
    startVh: c.startVh,
    endVh: c.endVh,
    startP: c.startP,
    endP: c.endP,
  }));
}

/** The chapter playing at progress p. The end screen holds the last chapter. */
export function chapterAt(p: number, s: Story = story): StoryChapter {
  const vh = clamp01(p) * s.totalVh;
  const list = s.chapters;
  for (let i = 0; i < list.length; i++) {
    if (vh < list[i].endVh) return list[i];
  }
  return list[list.length - 1];
}

/** Local time 0..1 inside the chapter playing at p (1 throughout the end screen). */
export function localT(p: number, s: Story = story): number {
  return localTOf(chapterAt(p, s), p, s);
}

/**
 * Local time 0..1 of one given chapter at p: 0 before the chapter starts and 1 after it ends, so
 * across a join the outgoing chapter holds its last frame and the incoming one its first.
 */
export function localTOf(c: StoryChapter, p: number, s: Story = story): number {
  return clamp01((clamp01(p) * s.totalVh - c.startVh) / c.scrollVh);
}

/** Fractional frame index (0 .. count-1) of the chapter playing at p. */
export function frameAt(p: number, s: Story = story, count?: number): number {
  const c = chapterAt(p, s);
  const n = count ?? c.frames;
  return localT(p, s) * (n - 1);
}

/** Progress of the end screen, 0 at the last film frame and 1 at the bottom of the page. */
export function endScreenT(p: number, s: Story = story): number {
  if (s.endScreenVh <= 0) return 0;
  return clamp01((clamp01(p) - s.filmEndP) / (1 - s.filmEndP));
}

export interface JoinWindow {
  type: Exclude<JoinType, "none">;
  from: StoryChapter;
  to: StoryChapter;
  /** Window bounds and the chapter boundary, in p. */
  startP: number;
  boundaryP: number;
  endP: number;
}

/**
 * The join window from `chapter` into the next present chapter: tune.joinFrames frames that
 * straddle the boundary (tune.joinSplit of them in the outgoing chapter, measured in each
 * chapter's own frame spacing). Null for the last chapter or a 'none' join.
 */
export function joinWindow(chapter: StoryChapter | string, s: Story = story): JoinWindow | null {
  const from = typeof chapter === "string" ? s.chapters.find((c) => c.id === chapter) : chapter;
  if (!from) return null;
  const to = s.chapters[from.index + 1];
  if (!to || from.joinOut === "none") return null;
  const before = tune.joinFrames * tune.joinSplit * (from.scrollVh / from.frames);
  const after = tune.joinFrames * (1 - tune.joinSplit) * (to.scrollVh / to.frames);
  return {
    type: from.joinOut,
    from,
    to,
    startP: (from.endVh - before) / s.totalVh,
    boundaryP: from.endVh / s.totalVh,
    endP: (from.endVh + after) / s.totalVh,
  };
}

/** Join time t in 0..1 for p inside the window, null outside it (where every join term is zero). */
export function joinT(p: number, w: JoinWindow): number | null {
  if (p <= w.startP || p >= w.endP) return null;
  return (p - w.startP) / (w.endP - w.startP);
}

/** The join active at p, if any, with its time t. */
export function joinAt(p: number, s: Story = story): { window: JoinWindow; t: number } | null {
  for (const c of s.chapters) {
    const w = joinWindow(c, s);
    if (!w) continue;
    const t = joinT(p, w);
    if (t !== null) return { window: w, t };
  }
  return null;
}

/** Frame folder of a clip at a tier, e.g. /frames/c01-follow/1440. */
export function framePath(clip: string, tier: number, index: number): string {
  return `/frames/${clip}/${tier}/f_${String(index + 1).padStart(3, "0")}.webp`;
}

/** Where an overlay file is served from (copied from art/source/overlays/ by npm run overlays). */
export function overlayPath(name: OverlayName): string {
  return `/overlays/${tune.overlays[name].file}`;
}

export function manifestPath(clip: string): string {
  return `/frames/${clip}/manifest.json`;
}
