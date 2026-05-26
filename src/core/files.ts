import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { DEFAULT_IGNORE_PATTERNS, SUPPORTED_EXTENSIONS } from "./config.js";

interface DiscoverOptions {
  rootDir: string;
  paths?: string[];
  extraIgnore?: string[];
}

export async function discoverFiles(opts: DiscoverOptions): Promise<string[]> {
  const { rootDir, paths, extraIgnore = [] } = opts;
  const ext = `{${SUPPORTED_EXTENSIONS.join(",")}}`;
  const patterns =
    paths && paths.length > 0
      ? paths.map((p) => `${normalizePathInput(p)}/**/*.${ext}`)
      : [`**/*.${ext}`];

  const found = await fg(patterns, {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: [...DEFAULT_IGNORE_PATTERNS, ...extraIgnore],
    followSymbolicLinks: false,
  });

  const gi = loadGitignore(rootDir);
  const filtered = gi
    ? found.filter((abs) => {
        const rel = relative(rootDir, abs).split(sep).join("/");
        return rel === "" || !gi.ignores(rel);
      })
    : found;

  return filtered.map((f) => resolve(f)).sort();
}

function normalizePathInput(p: string): string {
  const trimmed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return ".";
  return trimmed;
}

function loadGitignore(rootDir: string): Ignore | null {
  const sources = collectGitignoreSources(rootDir);
  if (sources.length === 0) return null;
  const ig = ignore();
  for (const content of sources) ig.add(content);
  return ig;
}

function collectGitignoreSources(rootDir: string): string[] {
  const out: string[] = [];
  let dir = resolve(rootDir);
  while (true) {
    const candidate = `${dir}/.gitignore`;
    if (existsSync(candidate)) {
      try {
        out.push(readFileSync(candidate, "utf8"));
      } catch (_err) {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}
