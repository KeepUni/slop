import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Project, ScriptTarget, ts } from "ts-morph";

interface BuildProjectOptions {
  projectRoot: string;
  files: string[];
}

export function buildProject(opts: BuildProjectOptions): Project {
  const { projectRoot, files } = opts;
  const tsConfigPath = resolveEffectiveTsConfig(projectRoot);

  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
    compilerOptions: tsConfigPath
      ? undefined
      : {
          target: ScriptTarget.ESNext,
          allowJs: true,
          jsx: 4,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          isolatedModules: false,
          noEmit: true,
        },
  });

  for (const file of files) {
    project.addSourceFileAtPathIfExists(file);
  }

  return project;
}

function findTsConfigIn(dir: string): string | undefined {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveEffectiveTsConfig(projectRoot: string): string | undefined {
  const root = findTsConfigIn(projectRoot);
  if (!root) return undefined;
  const cfg = readTsConfig(root);
  if (!cfg) return root;
  if (cfg.compilerOptions?.paths) return root;
  const refs = Array.isArray(cfg.references) ? cfg.references : undefined;
  if (!refs) return root;
  for (const ref of refs) {
    if (!ref || typeof ref.path !== "string") continue;
    const refPath = resolveRefPath(dirname(root), ref.path);
    if (!refPath) continue;
    const refCfg = readTsConfig(refPath);
    if (refCfg?.compilerOptions?.paths) return refPath;
  }
  return root;
}

interface TsConfigShape {
  compilerOptions?: { paths?: Record<string, string[]> };
  references?: Array<{ path?: string }>;
}

function readTsConfig(path: string): TsConfigShape | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = ts.parseConfigFileTextToJson(path, raw);
    if (parsed.error || !parsed.config) return undefined;
    return parsed.config as TsConfigShape;
  } catch {
    return undefined;
  }
}

function resolveRefPath(baseDir: string, refPath: string): string | undefined {
  const candidate = resolve(baseDir, refPath);
  if (existsSync(candidate)) {
    if (candidate.endsWith(".json")) return candidate;
    const inner = join(candidate, "tsconfig.json");
    if (existsSync(inner)) return inner;
  }
  const asJson = `${candidate}.json`;
  if (existsSync(asJson)) return asJson;
  return undefined;
}

export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    if (looksLikeProjectRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

function looksLikeProjectRoot(dir: string): boolean {
  return (
    existsSync(join(dir, "tsconfig.json")) ||
    existsSync(join(dir, "jsconfig.json")) ||
    existsSync(join(dir, "package.json"))
  );
}
