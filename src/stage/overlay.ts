import { overlayPath, type OverlayName } from "@/content/story";

/**
 * A looping video overlay (the mist) as a source for the compositor. It owns one hidden <video>:
 * muted, looping, inline. It is fetched only once the story gets near the chapters that use it,
 * played only while it is visible, and paused otherwise. If the file is missing or cannot play, the
 * overlay stays "failed" and the stage carries on without it, silently.
 *
 * The compositor uploads a new texture whenever `version` changes. Where the browser offers
 * requestVideoFrameCallback the version follows the video's own frames and wakes the render loop, so
 * a page at rest costs a draw only per video frame; otherwise `polling` asks the engine for a frame
 * on every tick while the video plays.
 */

export interface OverlaySource {
  video: HTMLVideoElement;
  /** Changes when the video shows a new frame. */
  version: number;
}

type VideoWithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

export class VideoOverlay {
  private video: HTMLVideoElement | null = null;
  private failed = false;
  private playing = false;
  private version = 0;
  private callbacks = false;
  /** The browser refused to autoplay; try again only after retry(). */
  private blocked = false;
  private hadFrame = false;

  constructor(
    readonly name: OverlayName,
    private readonly wake: () => void,
  ) {}

  /** Start fetching the file (idempotent). */
  load() {
    if (this.video || this.failed || typeof document === "undefined") return;
    const video = document.createElement("video");
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("aria-hidden", "true");
    video.tabIndex = -1;
    // Attached but invisible and out of the way: some browsers do not decode a detached video.
    Object.assign(video.style, { position: "fixed", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", left: "-2px", top: "-2px" });
    video.addEventListener("error", this.fail);
    video.addEventListener("loadeddata", this.wake);
    video.addEventListener("seeked", this.onSeeked);
    document.body.appendChild(video);
    this.video = video;
    this.hadFrame = false;
    this.callbacks = typeof (video as VideoWithCallback).requestVideoFrameCallback === "function";
    video.src = overlayPath(this.name);
    video.load();
  }

  private fail = () => {
    this.failed = true;
    this.dispose();
  };

  private onSeeked = () => {
    this.version++;
    this.wake();
  };

  private onVideoFrame = () => {
    this.version++;
    this.wake();
    this.watch();
  };

  private watch() {
    const video = this.video as VideoWithCallback | null;
    if (video?.requestVideoFrameCallback && this.playing) video.requestVideoFrameCallback(this.onVideoFrame);
  }

  /** Play while wanted, pause otherwise. */
  setPlaying(want: boolean) {
    const video = this.video;
    if (!video || this.failed) return;
    if (want && this.blocked) return;
    if (want === this.playing) return;
    this.playing = want;
    if (want) {
      void video.play().catch(() => {
        // Autoplay refused: keep showing the first frame, still.
        this.playing = false;
        this.blocked = true;
      });
      this.watch();
    } else {
      video.pause();
    }
  }

  /**
   * Hold the video still at a time of its loop (?clock=, for exact screenshots), or just pause it (null).
   * The version moves when the seek lands, which wakes the render loop.
   */
  hold(seconds: number | null) {
    const video = this.video;
    if (!video || this.failed) return;
    this.setPlaying(false);
    if (seconds === null || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const target = seconds % video.duration;
    if (Math.abs(video.currentTime - target) > 1e-3 && !video.seeking) video.currentTime = target;
  }

  /** Try again after a failure or a refused autoplay (development: frames and files can appear later). */
  retry() {
    this.blocked = false;
    if (this.failed) {
      this.failed = false;
      this.load();
    }
  }

  /** Whether the file is loading or showing (false once it failed or before load()). */
  get active(): boolean {
    return this.video !== null && !this.failed;
  }

  /** True when the engine must render every tick for the video to show its frames. */
  get polling(): boolean {
    return this.playing && !this.callbacks;
  }

  /** The video, if it has a frame to show. */
  source(): OverlaySource | null {
    const video = this.video;
    if (!video || this.failed || video.videoWidth === 0) return null;
    // A video that has shown a frame keeps its last one while it seeks or buffers (readyState dips).
    if (video.readyState >= 2) this.hadFrame = true;
    if (!this.hadFrame) return null;
    // Without frame callbacks, the playback position stands in for the frame version.
    const version = this.callbacks ? this.version : Math.round(video.currentTime * 60) + this.version;
    return { video, version };
  }

  dispose() {
    const video = this.video;
    if (!video) return;
    video.removeEventListener("error", this.fail);
    video.removeEventListener("loadeddata", this.wake);
    video.removeEventListener("seeked", this.onSeeked);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    this.video = null;
    this.playing = false;
  }
}
