import { existsSync } from "node:fs";
import path from "node:path";
import { chapters } from "./story";

/**
 * Optional clips whose frames are missing from public/frames (no manifest.json), checked on the
 * server when the page renders (every request in development, at build time in production).
 * The client re-checks the manifests, so frames that appear later are still picked up.
 */
export function missingOptionalClips(): string[] {
  const root = path.join(process.cwd(), "public", "frames");
  return chapters
    .filter((c) => c.optional && !existsSync(path.join(root, c.clip, "manifest.json")))
    .map((c) => c.clip);
}
