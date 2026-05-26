import type { SourceFile } from "ts-morph";
import { safeGetSpecifierSourceFile } from "../utils/ast.js";
import {
  collectEntryPoints,
  collectTemplateConsumption,
  forEachDynamicImportTarget,
} from "./entry-points.js";

interface ReachabilityResult {
  reachable: Set<string>;
  entries: Set<string>;
  noEntries: boolean;
}

export function computeReachability(files: SourceFile[], rootDir: string): ReachabilityResult {
  const entries = collectEntryPoints(files, rootDir);
  const templateRoots = collectTemplateConsumption(rootDir, files).namedSymbolsByFile.keys();
  const reachable = new Set<string>(entries);
  for (const root of templateRoots) reachable.add(root);
  if (entries.size === 0 && reachable.size === 0) {
    return { reachable: new Set(), entries, noEntries: true };
  }

  const filesByPath = new Map<string, SourceFile>();
  for (const sf of files) filesByPath.set(sf.getFilePath(), sf);

  const queue: string[] = [...reachable];

  while (queue.length > 0) {
    const filePath = queue.shift();
    if (!filePath) break;
    const sf = filesByPath.get(filePath);
    if (!sf) continue;
    for (const target of importTargetsOf(sf, filesByPath)) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }

  return { reachable, entries, noEntries: false };
}

export function findUnreachableFiles(
  files: SourceFile[],
  result: ReachabilityResult,
): string[] {
  if (result.noEntries) return [];
  const out: string[] = [];
  for (const sf of files) {
    const fp = sf.getFilePath();
    if (!result.reachable.has(fp)) out.push(fp);
  }
  return out;
}

function importTargetsOf(sf: SourceFile, filesByPath: Map<string, SourceFile>): string[] {
  const out: string[] = [];

  for (const imp of sf.getImportDeclarations()) {
    const target = safeGetSpecifierSourceFile(imp);
    if (target && filesByPath.has(target.getFilePath())) out.push(target.getFilePath());
  }

  for (const exp of sf.getExportDeclarations()) {
    const target = safeGetSpecifierSourceFile(exp);
    if (target && filesByPath.has(target.getFilePath())) out.push(target.getFilePath());
  }

  forEachDynamicImportTarget(sf, filesByPath, (resolved) => out.push(resolved));

  return out;
}
