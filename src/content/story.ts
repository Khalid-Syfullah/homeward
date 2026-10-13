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
  /** GPU textures kept for recently drawn frames. */
  textureCache: 6,
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

/** Words around the film (docs/COPY.md). Bracketed values are placeholders to replace. */
export const site = {
  wordmark: "Homeward",
  pageTitle: "Homeward, a scroll film",
  description: "[one sentence for search and sharing]",
  end: {
    heading: "Homeward",
    line: "[one sentence about you or the project]",
    link: { label: "[label]", href: "#" },
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
  const c = chapterAt(p, s);
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

export function manifestPath(clip: string): string {
  return `/frames/${clip}/manifest.json`;
}
