import { relative } from "node:path";
import type { Insight, Issue } from "../detectors/types.js";
import type { ScanResult } from "../core/scanner.js";

export interface JsonReport {
  version: 1;
  filesScanned: number;
  durationMs: number;
  rootDir: string;
  issues: Array<Issue & { relativeFile: string }>;
  insights: Array<Insight & { relativeFile: string }>;
}

export function toJson(result: ScanResult): JsonReport {
  return {
    version: 1,
    filesScanned: result.filesScanned,
    durationMs: result.durationMs,
    rootDir: result.rootDir,
    issues: result.issues.map((i) => withRelativeFile(i, fileOfIssue(i), result.rootDir)),
    insights: result.insights.map((i) => withRelativeFile(i, fileOfInsight(i), result.rootDir)),
  };
}

function withRelativeFile<T extends object>(
  record: T,
  absoluteFile: string,
  rootDir: string,
): T & { relativeFile: string } {
  return { ...record, relativeFile: relative(rootDir, absoluteFile).replace(/\\/g, "/") };
}

function fileOfIssue(issue: Issue): string {
  switch (issue.kind) {
    case "duplicate":
    case "same-shape-types":
      return issue.primary.file;
    default:
      return issue.location.file;
  }
}

function fileOfInsight(insight: Insight): string {
  switch (insight.kind) {
    case "orphaned-file":
    case "wrapper-only-file":
      return insight.file;
    case "dead-duplicate-pair":
      return insight.primary.file;
    case "dead-wrapper-chain":
      return insight.location.file;
    case "over-abstraction-chain":
      return insight.chain[0].location.file;
    case "scaffold-folder":
      return insight.files[0] ?? insight.folder;
  }
}
