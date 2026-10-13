import { tune, type Point } from "@/content/story";
import { coverFit, type Fit } from "./fit";
import type { FrameImage } from "./frameStore";

/**
 * The compositor: the only thing that draws. Raw WebGL 1 on the one fixed full-viewport canvas.
 * It draws the floor and ceil frames of the fractional frame index and blends them by the
 * fraction, each cover-fitted around its chapter's focal point (fit.ts), so 570 stored frames
 * scrub as a continuous picture.
 *
 * It keeps a small LRU of GPU textures (tune.textureCache) and always keeps the last pair it drew,
 * so it can redraw after a resize even when the frame store has let those frames go. It skips the
 * draw when nothing changed (the canvas keeps showing its last picture), so a page at rest costs
 * nothing. If WebGL is unavailable it falls back to a 2D canvas that blends the same way.
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

export interface Scene {
  a: Layer;
  b: Layer;
  /** 0 shows a, 1 shows b. */
  mix: number;
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

const VERTEX = `
attribute vec2 aPosition;
uniform vec4 uFitA;
uniform vec4 uFitB;
varying vec2 vUvA;
varying vec2 vUvB;
void main() {
  // Clip space to viewport coordinates (0..1, y down), then through each frame's cover fit.
  vec2 screen = vec2(aPosition.x, -aPosition.y) * 0.5 + 0.5;
  vUvA = screen * uFitA.xy + uFitA.zw;
  vUvB = screen * uFitB.xy + uFitB.zw;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uFrameA;
uniform sampler2D uFrameB;
uniform float uMix;
varying vec2 vUvA;
varying vec2 vUvB;
void main() {
  vec3 a = texture2D(uFrameA, vUvA).rgb;
  vec3 b = texture2D(uFrameB, vUvB).rgb;
  gl_FragColor = vec4(mix(a, b, uMix), 1.0);
}
`;

/** One triangle that covers the whole viewport. */
const COVER_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

interface Texture {
  texture: WebGLTexture;
  bytes: number;
  used: number;
}

interface Drawn {
  a: Omit<Layer, "image">;
  b: Omit<Layer, "image">;
  mix: number;
}

const fitVec = (f: Fit): [number, number, number, number] => [f.scaleX, f.scaleY, f.offsetX, f.offsetY];
const meta = ({ key, width, height, focal }: Layer) => ({ key, width, height, focal });

class WebGLCompositor implements Compositor {
  readonly kind = "webgl" as const;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uniforms: Record<"fitA" | "fitB" | "frameA" | "frameB" | "mix", WebGLUniformLocation | null> | null = null;
  private textures = new Map<string, Texture>();
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
    const vs = this.shader(gl.VERTEX_SHADER, VERTEX);
    const fs = this.shader(gl.FRAGMENT_SHADER, FRAGMENT);
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
    this.uniforms = {
      fitA: gl.getUniformLocation(program, "uFitA"),
      fitB: gl.getUniformLocation(program, "uFitB"),
      frameA: gl.getUniformLocation(program, "uFrameA"),
      frameB: gl.getUniformLocation(program, "uFrameB"),
      mix: gl.getUniformLocation(program, "uMix"),
    };

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

  private handleLost = (event: Event) => {
    event.preventDefault(); // ask for the context back
    this.lost = true;
    this.textures.clear();
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

    // Least recently used first; never the pair being drawn or the last pair drawn.
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

  draw(scene: Scene | null): boolean {
    const gl = this.gl;
    if (this.lost || gl.isContextLost() || !this.program || !this.uniforms) return false;

    let drawn: Drawn | null = this.last;
    let texA: Texture | null = null;
    let texB: Texture | null = null;
    if (scene) {
      const keep = new Set([scene.a.key, scene.b.key]);
      if (this.last) keep.add(this.last.a.key).add(this.last.b.key);
      texA = this.texture(scene.a, keep);
      texB = scene.b.key === scene.a.key ? texA : this.texture(scene.b, keep);
      if (texA && texB) drawn = { a: meta(scene.a), b: meta(scene.b), mix: scene.mix };
      else texA = texB = null; // an upload failed: keep showing the last pair
    }
    if (!drawn) return false;
    texA ??= this.textures.get(drawn.a.key) ?? null;
    texB ??= this.textures.get(drawn.b.key) ?? null;
    if (!texA || !texB) return false;

    const { width, height } = this.canvas;
    const { a, b, mix } = drawn;
    const signature = `${width}x${height}|${a.key}|${b.key}|${mix}|${a.focal.x},${a.focal.y}|${b.focal.x},${b.focal.y}`;
    this.last = drawn;
    if (signature === this.signature) return true; // already on screen
    this.signature = signature;

    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texA.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texB.texture);
    gl.uniform1i(u.frameA, 0);
    gl.uniform1i(u.frameB, 1);
    gl.uniform4fv(u.fitA, fitVec(coverFit(width, height, a.width, a.height, a.focal)));
    gl.uniform4fv(u.fitB, fitVec(coverFit(width, height, b.width, b.height, b.focal)));
    gl.uniform1f(u.mix, mix);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.textures.clear();
    this.last = null;
    this.signature = "";
  }
}

/** Fallback without WebGL: the same cover fit and blend with drawImage and globalAlpha. */
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

  private layer(layer: Layer, alpha: number) {
    const { width, height } = this.canvas;
    const fit = coverFit(width, height, layer.width, layer.height, layer.focal);
    const drawnW = width / fit.scaleX;
    const drawnH = height / fit.scaleY;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(layer.image, -fit.offsetX * drawnW, -fit.offsetY * drawnH, drawnW, drawnH);
  }

  draw(scene: Scene | null): boolean {
    // A 2D canvas keeps its pixels, so a redraw is only impossible after a resize.
    if (!scene) return this.signature !== "";
    const { a, b, mix } = scene;
    const signature = `${this.canvas.width}x${this.canvas.height}|${a.key}|${b.key}|${mix}`;
    if (signature === this.signature) return true;
    try {
      this.layer(a, 1);
      if (mix > 0 && b.key !== a.key) this.layer(b, mix);
    } catch {
      return this.signature !== "";
    } finally {
      this.ctx.globalAlpha = 1;
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
