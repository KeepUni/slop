import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Project, ScriptTarget } from "ts-morph";

interface BuildProjectOptions {
  projectRoot: string;
  files: string[];
}

export function buildProject(opts: BuildProjectOptions): Project {
  const { projectRoot, files } = opts;
  const tsConfigPath = findTsConfigIn(projectRoot);

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
