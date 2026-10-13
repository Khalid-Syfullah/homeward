import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { chapters, tune } from "./story";

/**
 * What the server knows about the frames in public/frames when the page renders (every request in
 * development, at build time in production). The client re-checks the manifests, so frames that appear
 * later are still picked up.
 */

/** A clip manifest as the page needs it: the fingerprint, whether it is a placeholder, and each tier's size. */
export interface InlineManifest {
  fingerprint: string;
  placeholder: boolean;
  tiers: Record<string, { count: number; width: number; height: number }>;
}

const framesRoot = () => path.join(process.cwd(), "public", "frames");

/**
 * Every clip's manifest.json (null where a clip has no frames), trimmed to what the stage uses. The page
 * inlines them, so the first frames are requested without waiting for the manifests (docs/PERF.md).
 */
export function readManifests(): Record<string, InlineManifest | null> {
  const out: Record<string, InlineManifest | null> = {};
  for (const c of chapters) {
    const file = path.join(framesRoot(), c.clip, "manifest.json");
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { fingerprint?: unknown; placeholder?: unknown; tiers?: unknown };
      const tiers: InlineManifest["tiers"] = {};
      for (const [tier, info] of Object.entries((raw.tiers ?? {}) as Record<string, { count?: unknown; width?: unknown; height?: unknown }>)) {
        if (typeof info?.count !== "number") continue;
        tiers[tier] = {
          count: info.count,
          width: typeof info.width === "number" ? info.width : Number(tier),
          height: typeof info.height === "number" ? info.height : Math.round(Number(tier) / tune.frameAspect),
        };
      }
      out[c.clip] = {
        fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : "",
        placeholder: raw.placeholder === true,
        tiers,
      };
    } catch {
      out[c.clip] = null;
    }
  }
  return out;
}

/** Optional clips whose frames are missing from public/frames (no manifest.json). */
export function missingOptionalClips(manifests?: Record<string, InlineManifest | null>): string[] {
  return chapters
    .filter((c) => c.optional && (manifests ? !manifests[c.clip] : !existsSync(path.join(framesRoot(), c.clip, "manifest.json"))))
    .map((c) => c.clip);
}
