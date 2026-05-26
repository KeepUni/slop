import { relative, resolve } from "node:path";
import type { Project } from "ts-morph";
import { aiSignaturesDetector } from "../detectors/ai-signatures.js";
import { codeSmellsDetector } from "../detectors/code-smells.js";
import { deadCodeDetector } from "../detectors/dead-code.js";
import { duplicatesDetector } from "../detectors/duplicates.js";
import { emptyWrappersDetector } from "../detectors/empty-wrappers.js";
import type { Detector, DetectorName, Insight, Issue } from "../detectors/types.js";
import type { ScanOptions } from "./config.js";
import { discoverFiles } from "./files.js";
import { combineInsights } from "./insights.js";
import {
  collectCrossWorkspaceImports,
  discoverWorkspacePackages,
  isMonorepo,
} from "./monorepo.js";
import { buildProject, findProjectRoot } from "./project.js";
import { buildReferencesCache } from "./references-cache.js";

export interface ScanResult {
  issues: Issue[];
  insights: Insight[];
  filesScanned: number;
  durationMs: number;
  rootDir: string;
  project: Project;
  // owning Project for a given source file. critical for monorepo --fix.
  projectForFile(filePath: string): Project | undefined;
}

const ALL_DETECTORS: Record<DetectorName, Detector> = {
  duplicates: duplicatesDetector,
  "dead-code": deadCodeDetector,
  "empty-wrappers": emptyWrappersDetector,
  "ai-signatures": aiSignaturesDetector,
  "code-smells": codeSmellsDetector,
};

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const cwd = resolve(options.rootDir);
  const anchor =
    options.paths && options.paths.length > 0 ? resolve(cwd, options.paths[0]) : cwd;
  const projectRoot = findProjectRoot(anchor);

  let filterPaths: string[] | undefined;
  if (options.paths && options.paths.length > 0) {
    const rebased = options.paths
      .map((p) => relative(projectRoot, resolve(cwd, p)))
      .filter((p) => p !== "" && p !== ".");
    filterPaths = rebased.length > 0 ? rebased : undefined;
  }

  const profile = !!process.env.SLP_PROFILE;
  const tDiscoverStart = profile ? Date.now() : 0;
  const filePaths = await discoverFiles({
    rootDir: projectRoot,
    paths: filterPaths,
    extraIgnore: options.ignore,
  });
  const tDiscover = profile ? Date.now() - tDiscoverStart : 0;

  const tProjectStart = profile ? Date.now() : 0;
  const project = buildProject({ projectRoot, files: filePaths });
  const sourceFiles = filePaths
    .map((p) => project.getSourceFile(p))
    .filter((sf): sf is NonNullable<typeof sf> => sf !== undefined);
  const tProject = profile ? Date.now() - tProjectStart : 0;

  const tRefsStart = profile ? Date.now() : 0;
  const refs = buildReferencesCache(sourceFiles);
  const tRefs = profile ? Date.now() - tRefsStart : 0;

  const enabled: DetectorName[] = options.only?.length
    ? [...options.only]
    : ["duplicates", "dead-code", "empty-wrappers", "ai-signatures", "code-smells"];

  const detectorTimings: Record<string, number> = {};
  const tDetectorsStart = profile ? Date.now() : 0;
  const detectorRuns = await Promise.all(
    enabled.map(async (name) => {
      const detector = ALL_DETECTORS[name];
      if (!detector) return [] as Issue[];
      const t0 = profile ? Date.now() : 0;
      const result = await detector.run({
        project,
        files: sourceFiles,
        rootDir: projectRoot,
        refs,
        externallyConsumed: options.externallyConsumed,
      });
      if (profile) detectorTimings[name] = Date.now() - t0;
      return result;
    }),
  );
  const tDetectors = profile ? Date.now() - tDetectorsStart : 0;
  let issues: Issue[] = detectorRuns.flat();

  if (profile) {
    process.stderr.write(
      `[profile] discover=${tDiscover}ms  project=${tProject}ms  ` +
        `refs-cache=${tRefs}ms  detectors=${tDetectors}ms  ` +
        `(${Object.entries(detectorTimings)
          .map(([k, v]) => `${k}=${v}ms`)
          .join(" ")})\n`,
    );
  }

  const { insights, consumedIssues } = combineInsights(issues, sourceFiles, projectRoot, {
    inMonorepoSubScan: options.inMonorepoSubScan === true,
  });
  if (!options.verbose) issues = issues.filter((i) => !consumedIssues.has(i));

  const floor = options.minConfidence ?? 0;
  let filteredInsights = insights;
  if (floor > 0) {
    issues = issues.filter((i) => i.confidence >= floor);
    filteredInsights = insights.filter((i) => i.confidence >= floor);
  }

  return {
    issues,
    insights: filteredInsights,
    filesScanned: sourceFiles.length,
    durationMs: Date.now() - started,
    rootDir: projectRoot,
    project,
    projectForFile: () => project,
  };
}

export async function scanMonorepo(options: ScanOptions): Promise<ScanResult> {
  const root = resolve(options.rootDir);
  if (!isMonorepo(root)) return scan(options);

  const packages = discoverWorkspacePackages(root);
  if (packages.length === 0) return scan(options);

  const started = Date.now();
  const crossRefs = collectCrossWorkspaceImports(root, packages);

  const allIssues: Issue[] = [];
  const allInsights: Insight[] = [];
  const projectByDir = new Map<string, Project>();
  let totalFiles = 0;
  let lastProject: Project | undefined;

  for (const pkg of packages) {
    const subResult = await scan({
      ...options,
      rootDir: pkg.dir,
      externallyConsumed: crossRefs.get(pkg.dir),
      inMonorepoSubScan: true,
    });
    allIssues.push(...subResult.issues);
    allInsights.push(...subResult.insights);
    totalFiles += subResult.filesScanned;
    lastProject = subResult.project;
    projectByDir.set(pkg.dir, subResult.project);
  }

  const fallback = lastProject ?? (await scan({ ...options, rootDir: root })).project;

  return {
    issues: allIssues,
    insights: allInsights,
    filesScanned: totalFiles,
    durationMs: Date.now() - started,
    rootDir: root,
    project: fallback,
    projectForFile(filePath: string): Project | undefined {
      const norm = filePath.replace(/\\/g, "/");
      // longest-prefix wins so nested workspaces resolve to the inner package.
      const sortedDirs = [...projectByDir.keys()].sort((a, b) => b.length - a.length);
      for (const dir of sortedDirs) {
        if (norm === dir || norm.startsWith(`${dir}/`)) return projectByDir.get(dir);
      }
      return undefined;
    },
  };
}
