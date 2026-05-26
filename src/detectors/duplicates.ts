import { type Block, Node, type SourceFile } from "ts-morph";
import {
  DUPLICATE_MAX_FILE_LINES,
  DUPLICATE_MIN_TOKENS,
  isGeneratedFilePath,
  isGeneratedSource,
  isTestFilePath,
} from "../core/config.js";
import { isFunctionLike } from "../utils/ast.js";
import { hashWindow, rawIdentityRatio } from "../utils/similarity.js";
import { type Token, scriptKindFromPath, tokenize } from "../utils/tokenize.js";
import type { Detector, DetectorContext, DuplicateIssue, Location } from "./types.js";

interface WindowEntry {
  file: string;
  start: number;
}

interface Match {
  startA: number;
  startB: number;
  len: number;
}

interface WindowPair {
  aLoc: Location;
  bLoc: Location;
  similarity: number;
  confidence: number;
  preview: string;
  len: number;
}

const FAT_BUCKET_LIMIT = 30;
const STRUCTURAL_MIN_NODES = 20;
const I18N_PATH_RE =
  /[\\/](?:locales?|i18n|translations?|messages?|langs?|intl)(?:[\\/]|\.[a-z]+$)/i;
const PUBLICATION_PATH_RE =
  /[\\/](?:registry|styles|themes|variants|templates?|examples|presets|demos|icons|assets)[\\/]/i;
const MIGRATIONS_PATH_RE = /[\\/]migrations?[\\/]/i;

export const duplicatesDetector: Detector = {
  name: "duplicates",
  async run(ctx: DetectorContext): Promise<DuplicateIssue[]> {
    const profile = !!process.env.SLP_PROFILE;
    const tStart = profile ? Date.now() : 0;

    const tokensByFile = new Map<string, Token[]>();
    const sourcesByPath = new Map<string, SourceFile>();
    for (const sf of ctx.files) {
      const filePath = sf.getFilePath();
      if (isTestFilePath(filePath, ctx.rootDir)) continue;
      if (isGeneratedFilePath(filePath)) continue;
      const source = sf.getFullText();
      if (isGeneratedSource(source) || source.split("\n").length > DUPLICATE_MAX_FILE_LINES) continue;
      const tokens = tokenize(source, scriptKindFromPath(filePath));
      if (tokens.length < DUPLICATE_MIN_TOKENS) continue;
      tokensByFile.set(filePath, tokens);
      sourcesByPath.set(filePath, sf);
    }
    const tTokenize = profile ? Date.now() - tStart : 0;

    const tBucketStart = profile ? Date.now() : 0;
    const buckets = new Map<string, WindowEntry[]>();
    for (const [file, tokens] of tokensByFile) {
      const last = tokens.length - DUPLICATE_MIN_TOKENS;
      for (let i = 0; i <= last; i++) {
        const h = hashWindow(tokens, i, DUPLICATE_MIN_TOKENS);
        let arr = buckets.get(h);
        if (!arr) {
          arr = [];
          buckets.set(h, arr);
        }
        arr.push({ file, start: i });
      }
    }

    const sortedBuckets = [...buckets.values()]
      .filter((entries) => entries.length >= 2)
      .sort((a, b) => b.length - a.length)
      .map((entries) =>
        entries.length > FAT_BUCKET_LIMIT ? entries.slice(0, FAT_BUCKET_LIMIT) : entries,
      );

    const consumed = new Set<string>();
    const windowPairs: WindowPair[] = [];
    const bodyCache = new Map<string, Block | null>();

    for (const entries of sortedBuckets) {
      for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        if (consumed.has(entryKey(a))) continue;
        for (let j = i + 1; j < entries.length; j++) {
          const b = entries[j];
          if (consumed.has(entryKey(b))) continue;
          if (a.file === b.file && Math.abs(a.start - b.start) < DUPLICATE_MIN_TOKENS) continue;
          if (I18N_PATH_RE.test(a.file) && I18N_PATH_RE.test(b.file)) continue;
          if (
            a.file !== b.file &&
            PUBLICATION_PATH_RE.test(a.file) &&
            PUBLICATION_PATH_RE.test(b.file)
          )
            continue;
          if (
            a.file !== b.file &&
            MIGRATIONS_PATH_RE.test(a.file) &&
            MIGRATIONS_PATH_RE.test(b.file)
          )
            continue;
          if (a.file !== b.file && sameBasename(a.file, b.file)) continue;

          const tokensA = tokensByFile.get(a.file);
          const tokensB = tokensByFile.get(b.file);
          if (!tokensA || !tokensB) continue;

          const match = extendMatch(tokensA, a.start, tokensB, b.start);
          if (match.len < DUPLICATE_MIN_TOKENS) continue;

          if (a.file === b.file) {
            const gap = Math.abs(match.startB - match.startA) - match.len;
            if (gap < DUPLICATE_MIN_TOKENS) continue;
          }

          const sfA = sourcesByPath.get(a.file);
          const sfB = sourcesByPath.get(b.file);
          if (!sfA || !sfB) continue;

          const clipped = clipMatchToFunctionBodies(tokensA, tokensB, match, sfA, sfB, bodyCache);
          if (!clipped) continue;

          const sliceA = tokensA.slice(clipped.startA, clipped.startA + clipped.len);
          const sliceB = tokensB.slice(clipped.startB, clipped.startB + clipped.len);
          const sim = rawIdentityRatio(sliceA, sliceB);

          for (let k = 0; k <= match.len - DUPLICATE_MIN_TOKENS; k++) {
            consumed.add(`${a.file}:${match.startA + k}`);
            consumed.add(`${b.file}:${match.startB + k}`);
          }

          windowPairs.push({
            aLoc: locationFromSlice(a.file, sliceA),
            bLoc: locationFromSlice(b.file, sliceB),
            similarity: sim,
            preview: makePreview(sliceA),
            confidence: scoreDuplicate(sim, clipped.len, a.file !== b.file),
            len: clipped.len,
          });
        }
      }
    }

    const issues: DuplicateIssue[] = coalesceWindowPairs(windowPairs);
    const tWindowEnd = profile ? Date.now() - tBucketStart : 0;
    const winIssueCount = issues.length;

    const tStructStart = profile ? Date.now() : 0;
    const fnIssues = collectStructuralFunctionDuplicates(sourcesByPath, issues);
    issues.push(...fnIssues);
    const tStruct = profile ? Date.now() - tStructStart : 0;

    if (profile) {
      process.stderr.write(
        `[duplicates] tokenize=${tTokenize}ms window=${tWindowEnd}ms (${winIssueCount}) ` +
          `structural=${tStruct}ms (${fnIssues.length})\n`,
      );
    }

    return issues;
  },
};

function entryKey(e: WindowEntry): string {
  return `${e.file}:${e.start}`;
}

function coalesceWindowPairs(pairs: WindowPair[]): DuplicateIssue[] {
  if (pairs.length === 0) return [];

  const locKey = (loc: Location) => `${loc.file}:${loc.line}`;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (true) {
      const next = parent.get(cur);
      if (next === undefined || next === cur) return cur;
      cur = next;
    }
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const p of pairs) {
    const a = locKey(p.aLoc);
    const b = locKey(p.bLoc);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    union(a, b);
  }

  const clusters = new Map<string, WindowPair[]>();
  for (const p of pairs) {
    const root = find(locKey(p.aLoc));
    const arr = clusters.get(root) ?? [];
    arr.push(p);
    clusters.set(root, arr);
  }

  const out: DuplicateIssue[] = [];
  for (const group of clusters.values()) {
    group.sort((a, b) => b.len - a.len);
    const head = group[0];
    const primaryBase = basenameOf(head.aLoc.file);

    const seen = new Set<string>([locKey(head.aLoc)]);
    const matches: Location[] = [];
    const considerLoc = (loc: Location) => {
      const key = locKey(loc);
      if (seen.has(key)) return;
      seen.add(key);
      if (loc.file !== head.aLoc.file && basenameOf(loc.file) === primaryBase) return;
      matches.push(loc);
    };
    considerLoc(head.bLoc);
    for (const p of group.slice(1)) {
      considerLoc(p.aLoc);
      considerLoc(p.bLoc);
    }

    if (matches.length === 0) continue;

    out.push({
      kind: "duplicate",
      primary: head.aLoc,
      matches,
      similarity: Math.max(...group.map((g) => g.similarity)),
      preview: head.preview,
      confidence: Math.max(...group.map((g) => g.confidence)),
    });
  }
  return out;
}

function scoreDuplicate(similarity: number, len: number, crossFile: boolean): number {
  let score = similarity - 0.15;
  if (crossFile) score += 0.05;
  if (len < DUPLICATE_MIN_TOKENS * 1.5) score -= 0.15;
  return clamp01(score);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function extendMatch(a: Token[], ai: number, b: Token[], bi: number): Match {
  let fwd = 0;
  while (
    ai + fwd < a.length &&
    bi + fwd < b.length &&
    a[ai + fwd].normalized === b[bi + fwd].normalized
  ) {
    fwd++;
  }
  let back = 0;
  while (
    ai - back - 1 >= 0 &&
    bi - back - 1 >= 0 &&
    a[ai - back - 1].normalized === b[bi - back - 1].normalized
  ) {
    back++;
  }
  return { startA: ai - back, startB: bi - back, len: back + fwd };
}

function clipMatchToFunctionBodies(
  tokensA: Token[],
  tokensB: Token[],
  match: Match,
  sfA: SourceFile,
  sfB: SourceFile,
  bodyCache: Map<string, Block | null>,
): Match | undefined {
  const mid = Math.floor(match.len / 2);
  const bodyA = cachedEnclosingFunctionBody(sfA, tokensA[match.startA + mid].pos, bodyCache);
  const bodyB = cachedEnclosingFunctionBody(sfB, tokensB[match.startB + mid].pos, bodyCache);
  if (!bodyA || !bodyB) return undefined;

  const bodyAStart = bodyA.getStart();
  const bodyAEnd = bodyA.getEnd();
  const bodyBStart = bodyB.getStart();
  const bodyBEnd = bodyB.getEnd();

  let frontA = 0;
  while (frontA < match.len && tokensA[match.startA + frontA].pos < bodyAStart) frontA++;
  let frontB = 0;
  while (frontB < match.len && tokensB[match.startB + frontB].pos < bodyBStart) frontB++;
  const front = Math.max(frontA, frontB);

  let backA = 0;
  while (
    backA < match.len - front &&
    tokensA[match.startA + match.len - 1 - backA].pos >= bodyAEnd
  ) {
    backA++;
  }
  let backB = 0;
  while (
    backB < match.len - front &&
    tokensB[match.startB + match.len - 1 - backB].pos >= bodyBEnd
  ) {
    backB++;
  }
  const back = Math.max(backA, backB);

  const newLen = match.len - front - back;
  if (newLen < DUPLICATE_MIN_TOKENS) return undefined;
  return {
    startA: match.startA + front,
    startB: match.startB + front,
    len: newLen,
  };
}

function enclosingFunctionBody(sf: SourceFile, pos: number): Block | undefined {
  let node: Node | undefined = sf.getDescendantAtPos(pos);
  while (node) {
    if (isFunctionLike(node)) {
      const body = (node as { getBody?: () => Node | undefined }).getBody?.();
      if (body && Node.isBlock(body) && body.getStart() <= pos && body.getEnd() > pos) {
        return body;
      }
    }
    node = node.getParent();
  }
  return undefined;
}

function cachedEnclosingFunctionBody(
  sf: SourceFile,
  pos: number,
  cache: Map<string, Block | null>,
): Block | undefined {
  const key = `${sf.getFilePath()}:${pos}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const result = enclosingFunctionBody(sf, pos);
  cache.set(key, result ?? null);
  return result;
}

interface FunctionFingerprint {
  file: string;
  name: string;
  location: Location;
  hash: string;
  nodeCount: number;
  bodyStartLine: number;
  bodyEndLine: number;
}

function collectStructuralFunctionDuplicates(
  sourcesByPath: Map<string, SourceFile>,
  windowIssues: DuplicateIssue[],
): DuplicateIssue[] {
  const fingerprints: FunctionFingerprint[] = [];
  for (const [file, sf] of sourcesByPath) {
    collectFingerprintsFromFile(sf, file, fingerprints);
  }

  const byHash = new Map<string, FunctionFingerprint[]>();
  for (const fp of fingerprints) {
    const arr = byHash.get(fp.hash) ?? [];
    arr.push(fp);
    byHash.set(fp.hash, arr);
  }

  const out: DuplicateIssue[] = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    if (allMembersCoveredByWindowMatch(group, windowIssues)) continue;
    if (group.every((g) => I18N_PATH_RE.test(g.file))) continue;
    if (group.every((g) => PUBLICATION_PATH_RE.test(g.file))) continue;
    if (group.every((g) => MIGRATIONS_PATH_RE.test(g.file))) continue;
    if (allSameBasename(group)) continue;

    const distinctNames = new Set(group.map((g) => g.name));
    if (distinctNames.size < 2) continue;

    const [primary, ...rest] = group;
    out.push({
      kind: "duplicate",
      primary: primary.location,
      matches: rest.map((r) => r.location),
      similarity: 1,
      preview: makeStructuralPreview(primary, rest),
      confidence: scoreStructuralDuplicate(group),
    });
  }
  return out;
}

function collectFingerprintsFromFile(
  sf: SourceFile,
  file: string,
  out: FunctionFingerprint[],
): void {
  sf.forEachDescendant((node) => {
    if (!isFunctionLike(node)) return;
    const fn = node as unknown as {
      getBody?: () => Node | undefined;
      getNameNode?: () => Node | undefined;
      getName?: () => string | undefined;
    };
    const body = fn.getBody?.();
    if (!body || !Node.isBlock(body)) return;

    let count = 0;
    const parts: string[] = [];
    body.forEachDescendant((n, traversal) => {
      if (isFunctionLike(n)) {
        parts.push(String(n.getKind()));
        count++;
        traversal.skip();
        return;
      }
      count++;
      parts.push(String(n.getKind()));
    });
    if (count < STRUCTURAL_MIN_NODES) return;

    const name = derivedName(node, fn);
    if (!name) return;
    const anchor = anchorFor(node, fn, sf);
    if (!anchor) return;

    const { line: bodyStartLine } = sf.getLineAndColumnAtPos(body.getStart());
    const { line: bodyEndLine } = sf.getLineAndColumnAtPos(body.getEnd());
    out.push({
      file,
      name,
      location: anchor,
      hash: fnv1a(parts.join("|")),
      nodeCount: count,
      bodyStartLine,
      bodyEndLine,
    });
  });
}

function derivedName(
  node: Node,
  fn: { getName?: () => string | undefined },
): string | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return fn.getName?.() ?? undefined;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      const nameNode = parent.getNameNode();
      if (Node.isIdentifier(nameNode)) return nameNode.getText();
    }
    if (parent && Node.isPropertyAssignment(parent)) {
      return parent.getName();
    }
  }
  return undefined;
}

function anchorFor(
  node: Node,
  fn: { getNameNode?: () => Node | undefined },
  sf: SourceFile,
): Location | undefined {
  let anchorPos: number | undefined;
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    anchorPos = fn.getNameNode?.()?.getStart() ?? node.getStart();
  } else if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      anchorPos = parent.getNameNode().getStart();
    } else if (parent && Node.isPropertyAssignment(parent)) {
      anchorPos = parent.getNameNode().getStart();
    }
  }
  if (anchorPos === undefined) return undefined;
  const { line, column } = sf.getLineAndColumnAtPos(anchorPos);
  return { file: sf.getFilePath(), line, column };
}

function allMembersCoveredByWindowMatch(
  group: FunctionFingerprint[],
  windowIssues: DuplicateIssue[],
): boolean {
  for (const member of group) {
    let covered = false;
    for (const issue of windowIssues) {
      const locs = [issue.primary, ...issue.matches];
      for (const loc of locs) {
        if (loc.file !== member.file) continue;
        const winStart = loc.line;
        const winEnd = loc.endLine ?? loc.line;
        if (winStart <= member.bodyEndLine && winEnd >= member.bodyStartLine) {
          covered = true;
          break;
        }
      }
      if (covered) break;
    }
    if (!covered) return false;
  }
  return true;
}

function makeStructuralPreview(
  primary: FunctionFingerprint,
  rest: FunctionFingerprint[],
): string {
  const names = [primary.name, ...rest.map((r) => r.name)];
  return `${names.join(" / ")} — same AST shape (${primary.nodeCount} nodes)`;
}

function scoreStructuralDuplicate(group: FunctionFingerprint[]): number {
  let score = 0.7;
  if (group.length >= 3) score += 0.05;
  const minSize = Math.min(...group.map((g) => g.nodeCount));
  score += Math.min(0.05, ((minSize - STRUCTURAL_MIN_NODES) / 20) * 0.03);
  return clamp01(score);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function locationFromSlice(file: string, tokens: Token[]): Location {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  return { file, line: first.line, column: 1, endLine: last.line };
}

function makePreview(tokens: Token[]): string {
  const text = tokens
    .slice(0, 10)
    .map((t) => t.text)
    .join(" ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function basenameOf(file: string): string {
  const norm = file.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return slash === -1 ? norm : norm.slice(slash + 1);
}

function sameBasename(a: string, b: string): boolean {
  return basenameOf(a) === basenameOf(b);
}

function allSameBasename(group: { file: string }[]): boolean {
  if (group.length < 2) return false;
  const first = basenameOf(group[0].file);
  let sawDistinctFile = false;
  for (let i = 1; i < group.length; i++) {
    if (group[i].file !== group[0].file) sawDistinctFile = true;
    if (basenameOf(group[i].file) !== first) return false;
  }
  return sawDistinctFile;
}
