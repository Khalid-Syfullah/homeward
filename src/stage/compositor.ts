import { tune, type Point, type Rect } from "@/content/story";
import { coverFit, type Fit } from "./fit";
import type { FrameImage } from "./frameStore";
import { joinGeometry, type JoinGeometry, type JoinKind } from "./joins";
import type { PictureLook } from "./looks";
import type { OverlaySource } from "./overlay";

/**
 * The compositor: the only thing that draws. Raw WebGL 1 on the one fixed full-viewport canvas.
 * It draws the floor and ceil frames of the fractional frame index and blends them by the
 * fraction, each cover-fitted around its chapter's focal point (fit.ts), so 570 stored frames
 * scrub as a continuous picture.
 *
 * Inside a join window it draws two such pictures, the outgoing chapter's and the incoming one's,
 * through one of the join programs (push, portal, rect, or the plain dissolve under reduced
 * motion), with the numbers joins.ts works out from the join time t and the scroll speed. Every
 * program reads the frames through the same `picture` function as the plain program, and the join
 * geometry is exactly the identity at its ends, so the first and last instant of a join are the
 * plain frames to the bit: a join can never pop on or off. Pixels provably outside a join's effect
 * (beyond the portal's rim band, outside the photograph's soft edge) take a single-tap fast path.
 *
 * It keeps a small LRU of GPU textures (tune.textureCache) and always keeps the last frames it drew,
 * so it can redraw after a resize even when the frame store has let those frames go. It skips the
 * draw when nothing changed (the canvas keeps showing its last picture), so a page at rest costs
 * nothing. Each picture can carry a look (looks.ts: a zoom and drift about a point, and a vignette)
 * that its reads go through, and the whole scene can carry a screen-blended video overlay (the mist)
 * on top; a look at rest and an overlay at zero opacity change no pixel. If WebGL is unavailable it falls back to a 2D canvas that blends the same way, with the
 * joins reduced to what a 2D context can clip and scale.
 */

export interface Layer {
  /** Identity of the frame (the frame store key); textures are cached by it. */
  key: string;
  image: FrameImage;
  width: number;
  height: number;
  /** Focal point in 0..1 frame coordinates, kept in view by the cover fit. */
  focal: Point;
}

/** One chapter's picture: its floor and ceil frames (same clip and tier, so one cover fit) and the blend. */
export interface Picture {
  a: Layer;
  b: Layer;
  /** 0 shows a, 1 shows b. */
  mix: number;
  /** The chapter's look (zoom, drift, vignette), if it has one showing. */
  look?: PictureLook | null;
}

/** A video blended over the finished picture with the screen blend, at an opacity. */
export interface OverlayScene {
  source: OverlaySource;
  /** 0..1; nothing is drawn at zero. */
  opacity: number;
}

/** A join in progress: the incoming chapter's picture and the numbers that place the transition. */
export interface JoinScene {
  kind: JoinKind;
  /** Join time, 0..1 across the window (never exactly 0 or 1: there the plain frame is drawn). */
  t: number;
  /** Absolute scroll speed, 0..1 (joins.ts). */
  speed: number;
  /** Device pixels per CSS pixel, for the join lengths in tune. */
  px: number;
  into: Picture;
  /** Anchors in 0..1 coordinates of the outgoing frame. */
  pupil?: Point;
  photoRect?: Rect;
}

/** What to draw: the picture of the chapter playing (the outgoing one inside a join), and the join. */
export interface Scene extends Picture {
  join?: JoinScene | null;
  overlay?: OverlayScene | null;
}

export interface CompositorStats {
  kind: "webgl" | "2d";
  textures: number;
  textureBytes: number;
  width: number;
  height: number;
}

export interface Compositor {
  readonly kind: "webgl" | "2d";
  /** Size the drawing buffer in device pixels (clears it, so draw in the same frame). */
  resize(width: number, height: number): void;
  /**
   * Draw the scene, or redraw the last one when scene is null. Returns true when the canvas shows
   * a picture afterwards, false when there was nothing to draw (or the context is lost).
   */
  draw(scene: Scene | null): boolean;
  stats(): CompositorStats;
  dispose(): void;
}

// ---------- shaders ----------

const VERTEX = `
attribute vec2 aPosition;
varying vec2 vScreen;
void main() {
  // Clip space to screen coordinates (0..1, y down, like the frames and their fits).
  vScreen = vec2(aPosition.x, -aPosition.y) * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Shared by every fragment program: the two pictures. `pictureA` is the chapter playing (the
 * outgoing one in a join), `pictureB` the incoming one. Each reads its floor and ceil frames
 * through the chapter's cover fit (screen 0..1 to frame uv) and blends them; the ceil frame is only
 * read when it differs from the floor frame. The join programs sample through these same functions,
 * so at the ends of a join (where their geometry is the identity) they produce the plain picture.
 */
const FRAGMENT_COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vScreen;
uniform vec2 uView;
uniform float uAspect;
uniform sampler2D uFrameA0;
uniform sampler2D uFrameB0;
uniform float uMix0;
uniform vec4 uFit0;
uniform sampler2D uFrameA1;
uniform sampler2D uFrameB1;
uniform float uMix1;
uniform vec4 uFit1;
// Vignettes, per picture: uVig = (centre xy, inner, outer radius squared, in viewport heights), uVigCol = (rgb,
// strength); zero strength at rest. The zoom and drift of a look are not here: they are composed
// into the cover fit (uFit) on the CPU, so the frame reads below are the plain ones to the bit.
uniform vec4 uVig0;
uniform vec4 uVigCol0;
uniform vec4 uVig1;
uniform vec4 uVigCol1;
// The overlay: its texture, its cover fit and its opacity (zero when there is none).
uniform sampler2D uMistTex;
uniform vec4 uMistFit;
uniform float uMistOpacity;

vec3 vignette(vec3 c, vec2 s, vec4 v, vec4 col) {
  if (col.w <= 0.0) return c;
  vec2 d = (s - v.xy) * vec2(uAspect, 1.0);
  float w = smoothstep(v.z, v.w, dot(d, d)) * col.w;
  return mix(c, col.rgb, w);
}

vec3 pictureA(vec2 screen) {
  vec2 uv = screen * uFit0.xy + uFit0.zw;
  vec3 c = texture2D(uFrameA0, uv).rgb;
  if (uMix0 > 0.0) c = mix(c, texture2D(uFrameB0, uv).rgb, uMix0);
  return vignette(c, screen, uVig0, uVigCol0);
}

vec3 pictureB(vec2 screen) {
  vec2 uv = screen * uFit1.xy + uFit1.zw;
  vec3 c = texture2D(uFrameA1, uv).rgb;
  if (uMix1 > 0.0) c = mix(c, texture2D(uFrameB1, uv).rgb, uMix1);
  return vignette(c, screen, uVig1, uVigCol1);
}

// Last step of every program: the screen blend of the overlay video over the finished picture.
vec3 finish(vec3 c, vec2 screen) {
  if (uMistOpacity > 0.0) {
    vec3 m = texture2D(uMistTex, screen * uMistFit.xy + uMistFit.zw).rgb;
    c = 1.0 - (1.0 - c) * (1.0 - m * uMistOpacity);
  }
  return c;
}
`;

const FRAGMENT_PLAIN = `${FRAGMENT_COMMON}
void main() {
  gl_FragColor = vec4(finish(pictureA(vScreen), vScreen), 1.0);
}
`;

/**
 * The two pictures blended. The ends are explicit: a GPU may compute mix(a, b, w) as
 * a + (b - a) * w, which is not exactly b at w = 1, and the ends of a join must be exact.
 */
const FRAGMENT_BLEND = `
vec3 blend(vec3 a, vec3 b, float w) {
  if (w <= 0.0) return a;
  if (w >= 1.0) return b;
  return mix(a, b, w);
}
`;

/** Reduced motion: every join is this plain cross-dissolve. */
const FRAGMENT_DISSOLVE = `${FRAGMENT_COMMON}${FRAGMENT_BLEND}
uniform float uMixAB;
void main() {
  vec3 c = pictureA(vScreen);
  if (uMixAB > 0.0) c = blend(c, pictureB(vScreen), uMixAB);
  gl_FragColor = vec4(finish(c, vScreen), 1.0);
}
`;

/**
 * Push: a cross-dissolve while the outgoing picture zooms in and the incoming one settles, with a
 * five-tap radial smear along the zoom whose reach follows the scroll speed. With no smear (at rest,
 * and at both ends of the window) every pixel takes the single-tap path.
 */
const FRAGMENT_PUSH = `${FRAGMENT_COMMON}${FRAGMENT_BLEND}
uniform float uMixAB;
uniform vec2 uZoom;
uniform vec2 uCentre;
uniform float uSmear;
void main() {
  vec2 radial = vScreen - uCentre;
  vec3 a = pictureA(vScreen + radial * uZoom.x);
  vec3 b = pictureB(vScreen + radial * uZoom.y);
  if (uSmear > 0.0) {
    // Four more taps along the radial line, as differences from the centre tap, so a vanishing
    // smear (its taps all on the same texel) leaves the centre tap exactly as it is.
    vec3 da = vec3(0.0);
    vec3 db = vec3(0.0);
    for (int i = -2; i <= 2; i++) {
      if (i == 0) continue;
      float k = uSmear * (float(i) * 0.5);
      da += pictureA(vScreen + radial * (uZoom.x + k)) - a;
      db += pictureB(vScreen + radial * (uZoom.y + k)) - b;
    }
    a += da * 0.2;
    b += db * 0.2;
  }
  gl_FragColor = vec4(finish(blend(a, b, uMixAB), vScreen), 1.0);
}
`;

/**
 * Portal: a circle opening from the pupil. Outside radius + band the pixel is provably the outgoing
 * picture and inside radius - band provably the incoming one (one tap each); only the rim band
 * computes the noise-bitten feathered edge and the faint dark ring.
 * uEdge = (feather, bite, ring width, ring strength); uBand = (band, noise cells around, cell length outward).
 */
const FRAGMENT_PORTAL = `${FRAGMENT_COMMON}
uniform vec2 uCentre;
uniform vec2 uCentreN;
uniform float uRadius;
uniform float uZoomIn;
uniform vec4 uEdge;
uniform vec3 uBand;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Value noise over (around, outward) cells; the around axis wraps at period, so the rim has no seam.
float vnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  float n00 = hash(vec2(x0, i.y));
  float n10 = hash(vec2(x1, i.y));
  float n01 = hash(vec2(x0, i.y + 1.0));
  float n11 = hash(vec2(x1, i.y + 1.0));
  return mix(mix(n00, n10, w.x), mix(n01, n11, w.x), w.y);
}

void main() {
  vec2 delta = vScreen * uView - uCentre;
  float d = length(delta);
  vec3 c;
  if (d >= uRadius + uBand.x) {
    c = pictureA(vScreen);
  } else {
    vec2 zoomed = vScreen + (vScreen - uCentreN) * uZoomIn;
    if (d <= uRadius - uBand.x) {
      c = pictureB(zoomed);
    } else {
      float around = (d > 0.5 ? atan(delta.y, delta.x) : 0.0) * 0.15915494 + 0.5;
      vec2 np = vec2(around * uBand.y, d / uBand.z);
      float n = vnoise(np, uBand.y) * 0.65 + vnoise(np * 2.0, uBand.y * 2.0) * 0.35;
      float dn = d + (n * 2.0 - 1.0) * uEdge.y;
      float m = 1.0 - smoothstep(uRadius - uEdge.x, uRadius, dn);
      c = mix(pictureA(vScreen), pictureB(zoomed), m);
      float x = (dn - uRadius) / uEdge.z;
      float ring = max(0.0, 1.0 - x * x);
      c *= 1.0 - uEdge.w * ring * ring;
    }
  }
  gl_FragColor = vec4(finish(c, vScreen), 1.0);
}
`;

/**
 * Rect: the photograph grows to fill the screen. The outgoing frame is read through a screen map
 * that zooms it with the rectangle (so its paper border slides off); the incoming frame's fit
 * (uFit1) is already composed with the rectangle. Pixels beyond the soft edge are provably the
 * outgoing frame, pixels inside once the dissolve is complete provably the incoming one.
 */
const FRAGMENT_RECT = `${FRAGMENT_COMMON}${FRAGMENT_BLEND}
uniform vec4 uRect;
uniform vec4 uOutMap;
uniform float uFeather;
uniform float uDissolve;
void main() {
  vec2 px = vScreen * uView;
  vec2 outside = max(max(uRect.xy - px, px - (uRect.xy + uRect.zw)), 0.0);
  float sd = length(outside);
  vec3 c;
  if (sd >= uFeather || uDissolve <= 0.0) {
    c = pictureA(vScreen * uOutMap.xy + uOutMap.zw);
  } else if (sd <= 0.0 && uDissolve >= 1.0) {
    c = pictureB(vScreen);
  } else {
    float w = uDissolve * (1.0 - smoothstep(0.0, uFeather, sd));
    c = blend(pictureA(vScreen * uOutMap.xy + uOutMap.zw), pictureB(vScreen), w);
  }
  gl_FragColor = vec4(finish(c, vScreen), 1.0);
}
`;

type ProgramName = "plain" | JoinKind;

const FRAGMENTS: Record<ProgramName, string> = {
  plain: FRAGMENT_PLAIN,
  dissolve: FRAGMENT_DISSOLVE,
  push: FRAGMENT_PUSH,
  portal: FRAGMENT_PORTAL,
  rect: FRAGMENT_RECT,
};

/** One triangle that covers the whole viewport. */
const COVER_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

/** Texture unit of the overlay (0 to 3 hold the four frames). */
const MIST_UNIT = 4;

/** Smallest width a smoothstep edge may have (its two edges must differ). */
const MIN_EDGE = 1e-3;

interface Texture {
  texture: WebGLTexture;
  bytes: number;
  used: number;
}

type LayerMeta = Omit<Layer, "image">;
interface PictureMeta {
  a: LayerMeta;
  b: LayerMeta;
  mix: number;
  look: PictureLook | null;
}
interface JoinMeta extends Omit<JoinScene, "into"> {
  into: PictureMeta;
}
/** A scene without its images: enough to redraw (the textures are cached by key) and to compare. */
interface Drawn extends PictureMeta {
  join: JoinMeta | null;
  overlay: OverlayScene | null;
}

const fitVec = (f: Fit): [number, number, number, number] => [f.scaleX, f.scaleY, f.offsetX, f.offsetY];
const meta = ({ key, width, height, focal }: Layer): LayerMeta => ({ key, width, height, focal });
const pictureMeta = (p: Picture): PictureMeta => ({ a: meta(p.a), b: meta(p.b), mix: p.mix, look: p.look ?? null });

function drawnOf(scene: Scene): Drawn {
  const join = scene.join
    ? { kind: scene.join.kind, t: scene.join.t, speed: scene.join.speed, px: scene.join.px, pupil: scene.join.pupil, photoRect: scene.join.photoRect, into: pictureMeta(scene.join.into) }
    : null;
  return { ...pictureMeta(scene), join, overlay: scene.overlay && scene.overlay.opacity > 0 ? scene.overlay : null };
}

function layersOf(scene: Scene): Layer[] {
  const list = [scene.a, scene.b];
  if (scene.join) list.push(scene.join.into.a, scene.join.into.b);
  return list;
}

function keysOf(drawn: Drawn): string[] {
  const list = [drawn.a.key, drawn.b.key];
  if (drawn.join) list.push(drawn.join.into.a.key, drawn.join.into.b.key);
  return list;
}

const pointSig = (p: Point) => `${p.x},${p.y}`;
const lookSig = (l: PictureLook | null) =>
  l
    ? `${pointSig(l.centre)},${l.term},${l.shiftY}` +
      (l.vignette ? `,${pointSig(l.vignette.centre)},${l.vignette.inner},${l.vignette.outer},${l.vignette.strength},${l.vignette.color.join(",")}` : "")
    : "-";
const pictureSig = (p: PictureMeta) => `${p.a.key}|${p.b.key}|${p.mix}|${pointSig(p.a.focal)}|${lookSig(p.look)}`;

function signatureOf(width: number, height: number, d: Drawn): string {
  let s = `${width}x${height}|${pictureSig(d)}`;
  const j = d.join;
  if (j) {
    s += `|${j.kind}|${j.t}|${j.speed}|${j.px}|${pictureSig(j.into)}`;
    if (j.pupil) s += `|${pointSig(j.pupil)}`;
    if (j.photoRect) s += `|${j.photoRect.x},${j.photoRect.y},${j.photoRect.w},${j.photoRect.h}`;
  }
  if (d.overlay) s += `|overlay ${d.overlay.opacity}@${d.overlay.source.version}`;
  return s;
}

/** The join's geometry for a drawn scene on a canvas of this size (device pixels). */
function geometryOf(width: number, height: number, d: Drawn): JoinGeometry | null {
  const j = d.join;
  if (!j) return null;
  return joinGeometry({
    kind: j.kind,
    t: j.t,
    speed: j.speed,
    width,
    height,
    px: j.px,
    out: { width: d.a.width, height: d.a.height, focal: d.a.focal },
    into: { width: j.into.a.width, height: j.into.a.height, focal: j.into.a.focal },
    pupil: j.pupil,
    photoRect: j.photoRect,
  });
}

/** A compiled program and its uniform locations, looked up once each. */
class Program {
  readonly program: WebGLProgram;
  private locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGLRenderingContext,
    vertex: string,
    fragment: string,
  ) {
    const vs = this.shader(gl.VERTEX_SHADER, vertex);
    const fs = this.shader(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    if (!vs || !fs || !program) throw new Error("WebGL: could not create the program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`WebGL: ${gl.getProgramInfoLog(program) ?? "link failed"}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
  }

  private shader(type: number, source: string) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`WebGL: ${gl.getShaderInfoLog(shader) ?? "compile failed"}`);
    }
    return shader;
  }

  loc(name: string): WebGLUniformLocation | null {
    let location = this.locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, location);
    }
    return location;
  }

  f(name: string, v: number) {
    this.gl.uniform1f(this.loc(name), v);
  }
  i(name: string, v: number) {
    this.gl.uniform1i(this.loc(name), v);
  }
  v2(name: string, x: number, y: number) {
    this.gl.uniform2f(this.loc(name), x, y);
  }
  v3(name: string, x: number, y: number, z: number) {
    this.gl.uniform3f(this.loc(name), x, y, z);
  }
  v4(name: string, x: number, y: number, z: number, w: number) {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
  }

  dispose() {
    this.gl.deleteProgram(this.program);
  }
}

class WebGLCompositor implements Compositor {
  readonly kind = "webgl" as const;
  private programs: Partial<Record<ProgramName, Program>> = {};
  private buffer: WebGLBuffer | null = null;
  private textures = new Map<string, Texture>();
  /** The overlay video's texture and the video frame version it holds. */
  private mist: { texture: WebGLTexture; version: number } | null = null;
  private tick = 0;
  private last: Drawn | null = null;
  private signature = "";
  private lost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
    private readonly onRestored: () => void,
  ) {
    canvas.addEventListener("webglcontextlost", this.handleLost);
    canvas.addEventListener("webglcontextrestored", this.handleRestored);
    this.init();
  }

  private init() {
    const gl = this.gl;
    // The plain program first: it is the one that must work. The join programs follow, so no join
    // ever waits on a shader compile mid-scroll.
    const programs: Partial<Record<ProgramName, Program>> = {};
    for (const name of Object.keys(FRAGMENTS) as ProgramName[]) {
      programs[name] = new Program(gl, VERTEX, FRAGMENTS[name]);
    }
    this.programs = programs;

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, COVER_TRIANGLE, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Frames upload top row first, which the vertex shader already accounts for.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private handleLost = (event: Event) => {
    event.preventDefault(); // ask for the context back
    this.lost = true;
    this.textures.clear();
    this.mist = null;
    this.programs = {};
    this.last = null;
    this.signature = "";
  };

  private handleRestored = () => {
    this.lost = false;
    this.init();
    this.onRestored();
  };

  resize(width: number, height: number) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.signature = "";
    if (!this.lost) this.gl.viewport(0, 0, width, height);
  }

  /** The texture for a layer, uploading it if needed; null if the upload failed. */
  private texture(layer: Layer, keep: ReadonlySet<string>): Texture | null {
    const gl = this.gl;
    const cached = this.textures.get(layer.key);
    if (cached) {
      cached.used = ++this.tick;
      return cached;
    }
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.image);
    } catch {
      gl.deleteTexture(texture);
      return null;
    }
    const entry = { texture, bytes: layer.width * layer.height * 4, used: ++this.tick };
    this.textures.set(layer.key, entry);

    // Least recently used first; never the frames being drawn or the frames last drawn.
    while (this.textures.size > tune.textureCache) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [key, t] of this.textures) {
        if (keep.has(key)) continue;
        if (t.used < oldest) {
          oldest = t.used;
          victim = key;
        }
      }
      if (victim === null) break;
      gl.deleteTexture(this.textures.get(victim)!.texture);
      this.textures.delete(victim);
    }
    return entry;
  }

  /**
   * Make the overlay texture hold the video's current frame. False if it cannot (the video has no
   * frame yet, or the upload is refused): the picture is then drawn without the overlay.
   */
  private uploadMist(overlay: OverlayScene): boolean {
    const gl = this.gl;
    const { video, version } = overlay.source;
    if (this.mist && this.mist.version === version) return true;
    let entry = this.mist;
    if (!entry) {
      const texture = gl.createTexture();
      if (!texture) return false;
      entry = { texture, version: -1 };
    }
    gl.activeTexture(gl.TEXTURE0 + MIST_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (entry.version < 0) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      if (!this.mist) gl.deleteTexture(entry.texture);
      return false;
    }
    entry.version = version;
    this.mist = entry;
    return true;
  }

  /** Upload every layer of the scene; null if one failed (the caller keeps showing the last scene). */
  private upload(scene: Scene): Map<string, Texture> | null {
    const keep = new Set(layersOf(scene).map((l) => l.key));
    if (this.last) for (const key of keysOf(this.last)) keep.add(key);
    const textures = new Map<string, Texture>();
    for (const layer of layersOf(scene)) {
      if (textures.has(layer.key)) continue;
      const texture = this.texture(layer, keep);
      if (!texture) return null;
      textures.set(layer.key, texture);
    }
    return textures;
  }

  draw(scene: Scene | null): boolean {
    const gl = this.gl;
    const plain = this.programs.plain;
    if (this.lost || gl.isContextLost() || !plain) return false;

    let drawn: Drawn | null = this.last;
    let uploaded: Map<string, Texture> | null = null;
    if (scene) {
      uploaded = this.upload(scene);
      if (!uploaded && scene.join) {
        // The incoming frames could not be uploaded: draw the plain picture rather than nothing.
        scene = { a: scene.a, b: scene.b, mix: scene.mix };
        uploaded = this.upload(scene);
      }
      if (uploaded) drawn = drawnOf(scene);
    }
    if (!drawn) return false;
    let textures = uploaded;
    if (!textures) {
      // A redraw (resize, or an upload failed): the last scene's textures, if they are all still here.
      textures = new Map();
      for (const key of keysOf(drawn)) {
        const t = this.textures.get(key);
        if (!t) return false;
        textures.set(key, t);
      }
    }
    const bound = textures;

    const { width, height } = this.canvas;
    const signature = signatureOf(width, height, drawn);
    this.last = drawn;
    if (signature === this.signature) return true; // already on screen
    this.signature = signature;

    const bind = (unit: number, key: string) => {
      const t = bound.get(key);
      if (!t) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
    };

    const geometry = geometryOf(width, height, drawn);
    const program = (geometry && this.programs[geometry.kind]) || plain;
    gl.useProgram(program.program);
    program.v2("uView", width, height);
    program.f("uAspect", width / height);

    // The overlay: its frame in a texture of its own, read through a cover fit of its own.
    let mistOpacity = 0;
    const overlay = drawn.overlay;
    if (overlay && this.uploadMist(overlay)) {
      mistOpacity = overlay.opacity;
      const { video } = overlay.source;
      const fit = coverFit(width, height, video.videoWidth, video.videoHeight, { x: 0.5, y: 0.5 });
      program.v4("uMistFit", ...fitVec(fit));
    }
    program.f("uMistOpacity", mistOpacity);
    program.i("uMistTex", MIST_UNIT);
    if (mistOpacity > 0 && this.mist) {
      gl.activeTexture(gl.TEXTURE0 + MIST_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.mist.texture);
    }
    const setVignette = (n: 0 | 1, look: PictureLook | null) => {
      const v = look?.vignette;
      program.v4(`uVig${n}`, v?.centre.x ?? 0.5, v?.centre.y ?? 0.5, (v?.inner ?? 0) ** 2, (v?.outer ?? 1) ** 2);
      program.v4(`uVigCol${n}`, v?.color[0] ?? 0, v?.color[1] ?? 0, v?.color[2] ?? 0, v?.strength ?? 0);
    };
    setVignette(0, drawn.look);

    bind(0, drawn.a.key);
    bind(1, drawn.b.key);
    program.i("uFrameA0", 0);
    program.i("uFrameB0", 1);
    program.f("uMix0", drawn.mix);
    const fitA = throughLook(coverFit(width, height, drawn.a.width, drawn.a.height, drawn.a.focal), drawn.look);
    program.v4("uFit0", ...fitVec(fitA));

    if (geometry && drawn.join) {
      const into = drawn.join.into;
      bind(2, into.a.key);
      bind(3, into.b.key);
      program.i("uFrameA1", 2);
      program.i("uFrameB1", 3);
      program.f("uMix1", into.mix);
      // The incoming frame's fit: the rect join composes it with the rectangle (joins.ts).
      const fitB = throughLook(
        geometry.kind === "rect" ? geometry.inFit : coverFit(width, height, into.a.width, into.a.height, into.a.focal),
        into.look,
      );
      program.v4("uFit1", ...fitVec(fitB));
      setVignette(1, into.look);

      switch (geometry.kind) {
        case "dissolve":
          program.f("uMixAB", geometry.mix);
          break;
        case "push":
          program.f("uMixAB", geometry.mix);
          program.v2("uZoom", geometry.zoomOut, geometry.zoomIn);
          program.v2("uCentre", geometry.centre.x, geometry.centre.y);
          program.f("uSmear", geometry.smear);
          break;
        case "portal":
          program.v2("uCentre", geometry.centre.x, geometry.centre.y);
          program.v2("uCentreN", geometry.centreN.x, geometry.centreN.y);
          program.f("uRadius", geometry.radius);
          program.f("uZoomIn", geometry.zoomIn);
          program.v4("uEdge", Math.max(geometry.feather, MIN_EDGE), geometry.bite, Math.max(geometry.ring, MIN_EDGE), geometry.ringStrength);
          program.v3("uBand", geometry.band, geometry.cells, Math.max(geometry.biteLength, MIN_EDGE));
          break;
        case "rect": {
          const { rect, outMap } = geometry;
          program.v4("uRect", rect.x, rect.y, rect.w, rect.h);
          program.v4("uOutMap", outMap.scaleX, outMap.scaleY, outMap.offsetX, outMap.offsetY);
          program.f("uFeather", Math.max(geometry.feather, MIN_EDGE));
          program.f("uDissolve", geometry.dissolve);
          break;
        }
      }
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  stats(): CompositorStats {
    let textureBytes = 0;
    for (const t of this.textures.values()) textureBytes += t.bytes;
    return { kind: this.kind, textures: this.textures.size, textureBytes, width: this.canvas.width, height: this.canvas.height };
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.handleLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleRestored);
    const gl = this.gl;
    if (!gl.isContextLost()) {
      for (const t of this.textures.values()) gl.deleteTexture(t.texture);
      if (this.mist) gl.deleteTexture(this.mist.texture);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      for (const p of Object.values(this.programs)) p?.dispose();
    }
    this.textures.clear();
    this.mist = null;
    this.programs = {};
    this.last = null;
    this.signature = "";
  }
}

// ---------- 2D fallback ----------

/** The fit that results from reading a picture at screen * scale + offset instead of at screen. */
function composeFit(fit: Fit, scaleX: number, scaleY: number, offsetX: number, offsetY: number): Fit {
  return {
    scaleX: fit.scaleX * scaleX,
    scaleY: fit.scaleY * scaleY,
    offsetX: fit.offsetX + offsetX * fit.scaleX,
    offsetY: fit.offsetY + offsetY * fit.scaleY,
  };
}

/**
 * The fit a picture is read through once its look's zoom and drift are applied: the picture is read at
 * s' = s * (1 + term) - centre * term + (0, shift), which composes into the cover fit as plain affine
 * numbers. A look at rest returns the fit itself, so the plain frame is untouched to the bit.
 */
function throughLook(fit: Fit, look: PictureLook | null | undefined): Fit {
  if (!look || (look.term === 0 && look.shiftY === 0)) return fit;
  const k = 1 + look.term;
  return composeFit(fit, k, k, -look.centre.x * look.term, -look.centre.y * look.term + look.shiftY);
}

/** A zoom about a centre (0..1 screen) by the radial term 1/k - 1, as a screen map. */
function zoomMap(centre: Point, term: number) {
  return { scaleX: 1 + term, scaleY: 1 + term, offsetX: -centre.x * term, offsetY: -centre.y * term };
}

/**
 * Fallback without WebGL: the same cover fit and blend with drawImage and globalAlpha. The joins
 * keep their geometry (zooms, the circle, the growing rectangle, the dissolves) but lose what a
 * 2D context cannot do cheaply: the smear, the feathered and bitten edge, and the ring.
 */
class Canvas2DCompositor implements Compositor {
  readonly kind = "2d" as const;
  private signature = "";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
  ) {}

  resize(width: number, height: number) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.signature = "";
  }

  private layer(layer: Layer, fit: Fit, alpha: number) {
    const { width, height } = this.canvas;
    const drawnW = width / fit.scaleX;
    const drawnH = height / fit.scaleY;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(layer.image, -fit.offsetX * drawnW, -fit.offsetY * drawnH, drawnW, drawnH);
  }

  /** A picture (its floor and ceil frames blended, its look applied) through a fit, at an overall alpha. */
  private picture(p: Picture, fit: Fit, alpha = 1) {
    const look = p.look;
    const through = throughLook(fit, look);
    this.layer(p.a, through, alpha);
    if (p.mix > 0 && p.b.key !== p.a.key) this.layer(p.b, through, alpha * p.mix);
    const v = look?.vignette;
    if (v && v.strength > 0) {
      const { width, height } = this.canvas;
      const cx = v.centre.x * width;
      const cy = v.centre.y * height;
      const rgb = v.color.map((c) => Math.round(c * 255)).join(",");
      const gradient = this.ctx.createRadialGradient(cx, cy, v.inner * height, cx, cy, v.outer * height);
      gradient.addColorStop(0, `rgba(${rgb},0)`);
      gradient.addColorStop(1, `rgba(${rgb},${v.strength})`);
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(0, 0, width, height);
    }
  }

  /** The overlay video over the finished picture, with the screen blend. */
  private overlay(overlay: OverlayScene) {
    const { video } = overlay.source;
    const { width, height } = this.canvas;
    if (video.videoWidth === 0) return;
    const fit = coverFit(width, height, video.videoWidth, video.videoHeight, { x: 0.5, y: 0.5 });
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = overlay.opacity;
    ctx.drawImage(video, (-fit.offsetX * width) / fit.scaleX, (-fit.offsetY * height) / fit.scaleY, width / fit.scaleX, height / fit.scaleY);
    ctx.restore();
  }

  draw(scene: Scene | null): boolean {
    // A 2D canvas keeps its pixels, so a redraw is only impossible after a resize.
    if (!scene) return this.signature !== "";
    const { width, height } = this.canvas;
    const drawn = drawnOf(scene);
    const signature = signatureOf(width, height, drawn);
    if (signature === this.signature) return true;
    const ctx = this.ctx;
    const fitA = coverFit(width, height, scene.a.width, scene.a.height, scene.a.focal);
    const geometry = geometryOf(width, height, drawn);
    const into = scene.join?.into;
    try {
      if (!geometry || !into) {
        this.picture(scene, fitA);
      } else {
        const fitB = coverFit(width, height, into.a.width, into.a.height, into.a.focal);
        switch (geometry.kind) {
          case "dissolve":
            this.picture(scene, fitA);
            if (geometry.mix > 0) this.picture(into, fitB, geometry.mix);
            break;
          case "push": {
            const zo = zoomMap(geometry.centre, geometry.zoomOut);
            const zi = zoomMap(geometry.centre, geometry.zoomIn);
            this.picture(scene, composeFit(fitA, zo.scaleX, zo.scaleY, zo.offsetX, zo.offsetY));
            if (geometry.mix > 0) this.picture(into, composeFit(fitB, zi.scaleX, zi.scaleY, zi.offsetX, zi.offsetY), geometry.mix);
            break;
          }
          case "portal": {
            this.picture(scene, fitA);
            const r = geometry.radius - geometry.feather * 0.5;
            if (r > 0) {
              const z = zoomMap(geometry.centreN, geometry.zoomIn);
              ctx.save();
              ctx.beginPath();
              ctx.arc(geometry.centre.x, geometry.centre.y, r, 0, Math.PI * 2);
              ctx.clip();
              this.picture(into, composeFit(fitB, z.scaleX, z.scaleY, z.offsetX, z.offsetY));
              ctx.restore();
            }
            break;
          }
          case "rect": {
            const { outMap, rect } = geometry;
            this.picture(scene, composeFit(fitA, outMap.scaleX, outMap.scaleY, outMap.offsetX, outMap.offsetY));
            if (geometry.dissolve > 0) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(rect.x, rect.y, rect.w, rect.h);
              ctx.clip();
              this.picture(into, geometry.inFit, geometry.dissolve);
              ctx.restore();
            }
            break;
          }
        }
      }
      if (drawn.overlay) this.overlay(drawn.overlay);
    } catch {
      return this.signature !== "";
    } finally {
      ctx.globalAlpha = 1;
    }
    this.signature = signature;
    return true;
  }

  stats(): CompositorStats {
    return { kind: this.kind, textures: 0, textureBytes: 0, width: this.canvas.width, height: this.canvas.height };
  }

  dispose() {
    this.signature = "";
  }
}

/** A WebGL compositor on the canvas, else the 2D fallback; null if the canvas gives neither. */
export function createCompositor(canvas: HTMLCanvasElement, onRestored: () => void): Compositor | null {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (gl) {
    try {
      return new WebGLCompositor(canvas, gl, onRestored);
    } catch (error) {
      // The canvas is bound to WebGL now, so it cannot fall back to 2D.
      console.warn("Homeward: the WebGL compositor failed to start.", error);
      return null;
    }
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  return ctx ? new Canvas2DCompositor(canvas, ctx) : null;
}
