// Load a self-contained TypeScript module (no imports of its own), such as src/content/story.ts,
// from a Node script. It is transpiled with the project's TypeScript and imported from a data URL,
// so the scripts and the site read the same numbers without a build step.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function loadTs(relPath) {
  const file = path.resolve(repoRoot, relPath);
  const source = await readFile(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const url = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  return import(url);
}

/** The story map: chapters, palette, tune and the helpers from src/content/story.ts. */
export function loadStory() {
  return loadTs("src/content/story.ts");
}
