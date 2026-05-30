import { Node, type SourceFile } from "ts-morph";
import type {
  DeadCodeIssue,
  DeadDuplicatePairInsight,
  DeadWrapperChainInsight,
  DuplicateIssue,
  EmptyWrapperIssue,
  Insight,
  Issue,
  OrphanedFileInsight,
  OverAbstractionChainInsight,
  ScaffoldFolderInsight,
  WrapperOnlyFileInsight,
} from "../detectors/types.js";
import { groupBy } from "../utils/group.js";
import { isMonorepo } from "./monorepo.js";
import { computeReachability, findUnreachableFiles } from "./reachability.js";

const SKIP_ORPHAN_PATTERN =
  /\.(test|spec|e2e|stories|story|bench|demo|example)\.[mc]?[jt]sx?$|\.d\.ts$|(^|\/)tests?\/|(^|\/)__[a-zA-Z0-9_-]+__\/|(^|\/)e2e\/|(^|\/)fixtures?\/|(^|\/)benchmarks?\/|(^|\/)benches?\/|(^|\/)examples?\/|(^|\/)playground\/|(^|\/)generated\/|(^|\/)gen\/|(^|\/)(perf|runtime|integration|smoke)(-(measures?|tests?|benchmarks?))?\/|(^|\/)vendor\//;

const WRAPPER_ONLY_FILE_SHARE = 0.5;
const WRAPPER_ONLY_FILE_MIN = 2;
const OVER_ABSTRACTION_MIN_DEPTH = 3;
const DEAD_CONTAINMENT_LINE_WINDOW = 200;
const SCAFFOLD_FOLDER_MIN = 3;
const SHADCN_UI_DIR_RE = /(^|\/)components\/ui$/;

interface CombinerResult {
  insights: Insight[];
  consumedIssues: Set<Issue>;
}

interface CombinerContext {
  inMonorepoSubScan: boolean;
}

export function combineInsights(
  issues: Issue[],
  files: SourceFile[],
  rootDir: string,
  ctx: CombinerContext = { inMonorepoSubScan: false },
): CombinerResult {
  const dead = issues.filter(isDeadCode);
  const wrappers = issues.filter(isWrapper);
  const duplicates = issues.filter(isDuplicate);

  const insights: Insight[] = [];
  const consumed = new Set<Issue>();

  insights.push(...buildScaffoldFolders(files, rootDir));
  insights.push(...buildOrphanedFiles(files, rootDir, dead, consumed, ctx));
  insights.push(...buildDeadWrapperChains(wrappers, dead, consumed));
  insights.push(...buildDeadDuplicatePairs(duplicates, dead, consumed));
  insights.push(...buildOverAbstractionChains(wrappers, consumed));
  insights.push(...buildWrapperOnlyFiles(wrappers, files, consumed));

  return { insights, consumedIssues: consumed };
}

function buildOrphanedFiles(
  files: SourceFile[],
  rootDir: string,
  dead: DeadCodeIssue[],
  consumed: Set<Issue>,
  ctx: CombinerContext,
): OrphanedFileInsight[] {
  if (ctx.inMonorepoSubScan) return [];
  if (isMonorepo(rootDir)) return [];

  const reachability = computeReachability(files, rootDir);
  const unreachable = findUnreachableFiles(files, reachability);
  const deadByFile = groupBy(dead, (d) => d.location.file);

  const orphans: OrphanedFileInsight[] = [];
  const scaffoldBuckets = new Map<string, { folder: string; files: string[]; baseConf: number }>();

  for (const file of unreachable) {
    const rel = relativeToRoot(file, rootDir);
    if (SKIP_ORPHAN_PATTERN.test(rel)) continue;

    const filesDead = deadByFile.get(file) ?? [];
    for (const issue of filesDead) consumed.add(issue);

    const baseConfidence = reachability.noEntries ? 0.7 : 0.9;
    const constituentMin = filesDead.length > 0 ? minConfidence(filesDead) : baseConfidence;
    const conf = Math.min(baseConfidence, constituentMin);

    const scaffoldRel = detectScaffoldDir(rel);
    if (scaffoldRel) {
      const absFolder = file.replace(/[\\/][^\\/]+$/, "");
      const bucket = scaffoldBuckets.get(scaffoldRel) ?? {
        folder: absFolder,
        files: [],
        baseConf: conf,
      };
      bucket.files.push(file);
      bucket.baseConf = Math.min(bucket.baseConf, conf);
      scaffoldBuckets.set(scaffoldRel, bucket);
      continue;
    }

    orphans.push({
      kind: "orphaned-file",
      file,
      deadSymbols: filesDead.map((d) => ({ symbol: d.symbol, line: d.location.line })),
      confidence: conf,
    });
  }

  for (const bucket of scaffoldBuckets.values()) {
    if (bucket.files.length < SCAFFOLD_FOLDER_MIN) {
      for (const file of bucket.files) {
        const filesDead = deadByFile.get(file) ?? [];
        orphans.push({
          kind: "orphaned-file",
          file,
          deadSymbols: filesDead.map((d) => ({ symbol: d.symbol, line: d.location.line })),
          confidence: bucket.baseConf,
        });
      }
    }
  }

  return orphans;
}

function buildScaffoldFolders(files: SourceFile[], rootDir: string): ScaffoldFolderInsight[] {
  if (isMonorepo(rootDir)) return [];

  const reachability = computeReachability(files, rootDir);
  const unreachable = findUnreachableFiles(files, reachability);
  const buckets = new Map<string, { folder: string; files: string[] }>();
  for (const file of unreachable) {
    const rel = relativeToRoot(file, rootDir);
    if (SKIP_ORPHAN_PATTERN.test(rel)) continue;
    const dir = detectScaffoldDir(rel);
    if (!dir) continue;
    const absFolder = file.replace(/[\\/][^\\/]+$/, "");
    const bucket = buckets.get(dir) ?? { folder: absFolder, files: [] };
    bucket.files.push(file);
    buckets.set(dir, bucket);
  }

  const out: ScaffoldFolderInsight[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.files.length < SCAFFOLD_FOLDER_MIN) continue;
    out.push({
      kind: "scaffold-folder",
      folder: bucket.folder,
      files: bucket.files,
      scaffold: "shadcn-ui",
      confidence: reachability.noEntries ? 0.6 : 0.8,
    });
  }
  return out;
}

function detectScaffoldDir(relativePath: string): string | undefined {
  const parent = relativePath.replace(/\/[^/]+$/, "");
  if (SHADCN_UI_DIR_RE.test(parent)) return parent;
  return undefined;
}

function buildDeadWrapperChains(
  wrappers: EmptyWrapperIssue[],
  dead: DeadCodeIssue[],
  consumed: Set<Issue>,
): DeadWrapperChainInsight[] {
  const deadIndex = new Map<string, DeadCodeIssue>();
  for (const d of dead) deadIndex.set(`${d.location.file}::${d.symbol}`, d);

  const out: DeadWrapperChainInsight[] = [];
  for (const w of wrappers) {
    const matched = deadIndex.get(`${w.location.file}::${w.outerName}`);
    if (!matched) continue;
    consumed.add(w);
    consumed.add(matched);
    out.push({
      kind: "dead-wrapper-chain",
      location: w.location,
      outerName: w.outerName,
      innerCall: w.innerCall,
      confidence: Math.min(w.confidence, matched.confidence),
    });
  }
  return out;
}

function buildOverAbstractionChains(
  wrappers: EmptyWrapperIssue[],
  consumed: Set<Issue>,
): OverAbstractionChainInsight[] {
  const out: OverAbstractionChainInsight[] = [];
  const byFile = groupBy(wrappers, (w) => w.location.file);
  const alreadyInChain = new Set<EmptyWrapperIssue>();

  for (const [, fileWrappers] of byFile) {
    const wrapperByName = new Map<string, EmptyWrapperIssue>();
    const calleeName = new Map<string, string>();
    for (const w of fileWrappers) {
      wrapperByName.set(w.outerName, w);
      const callee = simpleCalleeOf(w.innerCall);
      if (callee) calleeName.set(w.outerName, callee);
    }

    for (const w of fileWrappers) {
      if (alreadyInChain.has(w)) continue;
      const chain = walkChain(w, wrapperByName, calleeName);
      if (chain.length < OVER_ABSTRACTION_MIN_DEPTH) continue;

      const terminal = calleeName.get(chain[chain.length - 1].outerName);
      if (!terminal) continue;

      for (const link of chain) {
        alreadyInChain.add(link);
        consumed.add(link);
      }

      out.push({
        kind: "over-abstraction-chain",
        chain: chain.map((link) => ({ location: link.location, name: link.outerName })),
        terminalCall: terminal,
        confidence: scoreOverAbstraction(chain),
      });
    }
  }
  return out;
}

function walkChain(
  start: EmptyWrapperIssue,
  wrapperByName: Map<string, EmptyWrapperIssue>,
  calleeName: Map<string, string>,
): EmptyWrapperIssue[] {
  const chain: EmptyWrapperIssue[] = [];
  const seen = new Set<EmptyWrapperIssue>();
  let cursor: EmptyWrapperIssue | undefined = start;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    const next = calleeName.get(cursor.outerName);
    if (!next) break;
    cursor = wrapperByName.get(next);
  }
  return chain;
}

function simpleCalleeOf(innerCall: string): string | undefined {
  const m = innerCall.match(/^([A-Za-z_$][\w$]*)\(/);
  return m ? m[1] : undefined;
}

function scoreOverAbstraction(chain: EmptyWrapperIssue[]): number {
  const extra = Math.max(0, chain.length - OVER_ABSTRACTION_MIN_DEPTH);
  return Math.min(0.95, 0.85 + extra * 0.03);
}

function buildDeadDuplicatePairs(
  duplicates: DuplicateIssue[],
  dead: DeadCodeIssue[],
  consumed: Set<Issue>,
): DeadDuplicatePairInsight[] {
  const deadByFile = groupBy(dead, (d) => d.location.file);

  const out: DeadDuplicatePairInsight[] = [];
  for (const dup of duplicates) {
    const primaryDead = findContainingDead(dup.primary.file, dup.primary.line, deadByFile);
    if (!primaryDead) continue;

    const seen = new Set<DeadCodeIssue>([primaryDead]);
    const matchDead: DeadCodeIssue[] = [];
    let ok = true;
    for (const m of dup.matches) {
      const md = findContainingDead(m.file, m.line, deadByFile);
      if (!md || seen.has(md)) {
        ok = false;
        break;
      }
      seen.add(md);
      matchDead.push(md);
    }
    if (!ok) continue;

    consumed.add(dup);
    consumed.add(primaryDead);
    for (const md of matchDead) consumed.add(md);

    const allConfs = [dup.confidence, primaryDead.confidence, ...matchDead.map((d) => d.confidence)];
    out.push({
      kind: "dead-duplicate-pair",
      primary: dup.primary,
      matches: dup.matches,
      primarySymbol: primaryDead.symbol,
      matchSymbols: matchDead.map((d) => d.symbol),
      similarity: dup.similarity,
      confidence: Math.min(...allConfs),
    });
  }
  return out;
}

function findContainingDead(
  file: string,
  line: number,
  index: Map<string, DeadCodeIssue[]>,
): DeadCodeIssue | undefined {
  const arr = index.get(file);
  if (!arr) return undefined;
  let best: DeadCodeIssue | undefined;
  for (const d of arr) {
    if (d.location.line > line) continue;
    if (line - d.location.line > DEAD_CONTAINMENT_LINE_WINDOW) continue;
    if (!best || d.location.line > best.location.line) best = d;
  }
  return best;
}

function buildWrapperOnlyFiles(
  wrappers: EmptyWrapperIssue[],
  files: SourceFile[],
  consumed: Set<Issue>,
): WrapperOnlyFileInsight[] {
  return forEachQualifyingFile(
    wrappers,
    files,
    (w) => w.location.file,
    WRAPPER_ONLY_FILE_MIN,
    (file, ws, _sf, totalExports) => {
      if (ws.length > totalExports) return undefined;
      if (ws.length / totalExports < WRAPPER_ONLY_FILE_SHARE) return undefined;
      for (const w of ws) consumed.add(w);
      return {
        kind: "wrapper-only-file" as const,
        file,
        wrapperCount: ws.length,
        totalExports,
        confidence: avgConfidence(ws),
      };
    },
  );
}

function relativeToRoot(file: string, rootDir: string): string {
  const stripped = file.startsWith(rootDir) ? file.slice(rootDir.length + 1) : file;
  return stripped.replace(/\\/g, "/");
}

function countTopLevelExports(sf: SourceFile): number {
  let n = 0;
  for (const stmt of sf.getStatements()) {
    if (Node.isVariableStatement(stmt)) {
      if (stmt.isExported()) n += stmt.getDeclarations().length;
      continue;
    }
    if (Node.isExportDeclaration(stmt)) {
      const named = stmt.getNamedExports();
      n += named.length > 0 ? named.length : 1;
      continue;
    }
    if (Node.isExportAssignment(stmt)) {
      n += 1;
      continue;
    }
    const maybe = stmt as unknown as { isExported?: () => boolean };
    if (typeof maybe.isExported === "function" && maybe.isExported()) n += 1;
  }
  return n;
}

function indexFilesByPath(files: SourceFile[]): Map<string, SourceFile> {
  const out = new Map<string, SourceFile>();
  for (const sf of files) out.set(sf.getFilePath(), sf);
  return out;
}

function forEachQualifyingFile<I, R>(
  issues: I[],
  files: SourceFile[],
  getFile: (item: I) => string,
  minPerFile: number,
  finalize: (file: string, items: I[], sf: SourceFile, totalExports: number) => R | undefined,
): R[] {
  const byFile = groupBy(issues, getFile);
  const filesByPath = indexFilesByPath(files);
  const out: R[] = [];
  for (const [file, items] of byFile) {
    if (items.length < minPerFile) continue;
    const sf = filesByPath.get(file);
    if (!sf) continue;
    const totalExports = countTopLevelExports(sf);
    if (totalExports === 0) continue;
    const result = finalize(file, items, sf, totalExports);
    if (result !== undefined) out.push(result);
  }
  return out;
}

function minConfidence(issues: Array<{ confidence: number }>): number {
  let m = 1;
  for (const i of issues) if (i.confidence < m) m = i.confidence;
  return m;
}

function avgConfidence(issues: Array<{ confidence: number }>): number {
  if (issues.length === 0) return 0;
  let s = 0;
  for (const i of issues) s += i.confidence;
  return s / issues.length;
}

function isDeadCode(i: Issue): i is DeadCodeIssue {
  return i.kind === "dead-code";
}
function isWrapper(i: Issue): i is EmptyWrapperIssue {
  return i.kind === "empty-wrapper";
}
function isDuplicate(i: Issue): i is DuplicateIssue {
  return i.kind === "duplicate";
}
