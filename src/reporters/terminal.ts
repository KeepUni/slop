import { relative } from "node:path";
import pc from "picocolors";
import type { Insight, Issue, Location } from "../detectors/types.js";
import type { ScanResult } from "../core/scanner.js";
import { groupBy } from "../utils/group.js";

const KIND_LABEL: Record<Issue["kind"], string> = {
  duplicate: "dup",
  "dead-code": "dead",
  "unused-export": "unused",
  "empty-wrapper": "wrap",
  "useless-type-predicate": "pred",
  "same-shape-types": "shape",
  "useless-async": "async",
  "empty-catch": "catch",
};

const KIND_COLOR: Record<Issue["kind"], (s: string) => string> = {
  duplicate: pc.yellow,
  "dead-code": pc.red,
  "unused-export": pc.red,
  "empty-wrapper": pc.cyan,
  "useless-type-predicate": pc.blue,
  "same-shape-types": pc.yellow,
  "useless-async": pc.magenta,
  "empty-catch": pc.red,
};

const LABEL_WIDTH = 7;
const LINE_COL_WIDTH = 8;
const SYMBOL_WIDTH = 28;

export interface RenderOptions {
  color: boolean;
  hyperlinks: boolean;
  version: string;
  targetLabel: string;
  deadCodeFixable: number;
}

export function renderHeader(opts: RenderOptions): string {
  const c = makeColors(opts.color);
  return `${c.bold("slp")} ${c.dim(`v${opts.version}`)}  ${c.dim("·")}  scanning ${c.bold(opts.targetLabel)}\n`;
}

export function renderResult(result: ScanResult, opts: RenderOptions): string {
  const c = makeColors(opts.color);
  const totalFindings = result.issues.length + result.insights.length;
  if (totalFindings === 0) {
    return [
      `  ${c.bold(c.green("no slop detected"))}`,
      "",
      `  ${c.dim(`${formatFileCount(result.filesScanned)}  ·  ${formatDuration(result.durationMs)}`)}`,
      "",
    ].join("\n");
  }

  const lines: string[] = [];

  if (result.insights.length > 0) {
    lines.push(`  ${c.bold(c.magenta("INSIGHTS"))}`);
    for (const insight of result.insights) {
      lines.push(renderInsight(insight, result.rootDir, opts));
    }
    lines.push("");
  }

  if (result.issues.length > 0) {
    const byFile = groupBy(sortIssues(result.issues), primaryFile);
    const filesSorted = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [file, fileIssues] of filesSorted) {
      lines.push(`  ${formatFilePathHeader(file, result.rootDir, opts)}`);
      for (const issue of fileIssues) {
        lines.push(renderIssueLine(issue, result.rootDir, opts));
      }
      lines.push("");
    }
  }

  const parts: string[] = [];
  if (result.insights.length > 0) {
    parts.push(
      c.bold(`${result.insights.length} insight${result.insights.length === 1 ? "" : "s"}`),
    );
  }
  if (result.issues.length > 0) {
    parts.push(c.bold(`${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}`));
  }
  lines.push(
    `  ${parts.join(`  ${c.dim("·")}  `)}  ${c.dim("·")}  ${formatFileCount(result.filesScanned)}  ${c.dim("·")}  ${formatDuration(result.durationMs)}`,
  );

  if (opts.deadCodeFixable > 0) {
    lines.push(
      `  ${c.dim("→")} ${c.bold("--fix")} removes ${opts.deadCodeFixable} dead-code item${opts.deadCodeFixable === 1 ? "" : "s"}`,
    );
  }
  lines.push(
    `  ${c.dim("verify each finding — confidence is a hint, not a verdict")}`,
  );
  lines.push("");
  return lines.join("\n");
}

export function renderInsight(
  insight: Insight,
  rootDir: string,
  opts: Pick<RenderOptions, "color" | "hyperlinks">,
): string {
  const c = makeColors(opts.color);
  const anchor = anchorOf(insight);
  const path = formatAnchorPath(anchor, rootDir, opts);
  const conf = renderConfidence(insight.confidence, opts.color);
  const summary = describeInsight(insight);
  return `    ${conf} ${c.magenta(padEnd(insight.kind, 21))} ${path}  ${c.dim(summary)}`;
}

function describeInsight(insight: Insight): string {
  switch (insight.kind) {
    case "orphaned-file":
      if (insight.deadSymbols.length === 0) return "unreachable from any entry point";
      return `${insight.deadSymbols.length} unused export${insight.deadSymbols.length === 1 ? "" : "s"}: ${sampleSymbols(insight.deadSymbols)}`;
    case "scaffold-folder":
      return `${insight.scaffold === "shadcn-ui" ? "shadcn-ui scaffold" : insight.scaffold} — ${insight.files.length} unused components`;
    case "dead-wrapper-chain":
      return `${insight.outerName} → ${insight.innerCall}; never called`;
    case "dead-duplicate-pair":
      return `${[insight.primarySymbol, ...insight.matchSymbols].join(" / ")} are identical and all unused`;
    case "wrapper-only-file":
      return `${insight.wrapperCount} of ${insight.totalExports} exports are pass-throughs`;
    case "over-abstraction-chain":
      return `${insight.chain.map((c) => c.name).join(" → ")} → ${insight.terminalCall}`;
  }
}

function sampleSymbols(symbols: Array<{ symbol: string }>): string {
  const sample = symbols
    .slice(0, 3)
    .map((s) => s.symbol)
    .join(", ");
  return symbols.length > 3 ? `${sample}, +${symbols.length - 3} more` : sample;
}

function anchorOf(insight: Insight): Location | string {
  switch (insight.kind) {
    case "orphaned-file":
    case "wrapper-only-file":
      return insight.file;
    case "scaffold-folder":
      return insight.folder;
    case "dead-wrapper-chain":
      return insight.location;
    case "dead-duplicate-pair":
      return insight.primary;
    case "over-abstraction-chain":
      return insight.chain[0].location;
  }
}

function renderIssueLine(
  issue: Issue,
  rootDir: string,
  opts: Pick<RenderOptions, "color" | "hyperlinks">,
): string {
  const c = makeColors(opts.color);
  const label = KIND_COLOR[issue.kind](padEnd(KIND_LABEL[issue.kind], LABEL_WIDTH));
  const conf = renderConfidence(issue.confidence, opts.color);
  const loc = primaryLocation(issue);
  const lineCol = padEnd(formatLineCol(loc), LINE_COL_WIDTH);
  const symbol = c.bold(padEnd(truncate(symbolOf(issue), SYMBOL_WIDTH), SYMBOL_WIDTH));
  const description = describeIssue(issue, rootDir);
  return `    ${conf} ${c.dim(lineCol)} ${label} ${symbol} ${c.dim(description)}`;
}

function formatLineCol(loc: Location): string {
  if (loc.endLine && loc.endLine !== loc.line) return `${loc.line}-${loc.endLine}`;
  return String(loc.line);
}

function symbolOf(issue: Issue): string {
  switch (issue.kind) {
    case "dead-code":
    case "unused-export":
      return issue.symbol;
    case "empty-wrapper":
      return issue.outerName;
    case "useless-type-predicate":
      return issue.predicateName;
    case "same-shape-types":
      return issue.primaryName;
    case "useless-async":
      return issue.functionName;
    case "empty-catch":
      return "catch";
    case "duplicate":
      return "block";
  }
}

function describeIssue(issue: Issue, rootDir: string): string {
  switch (issue.kind) {
    case "dead-code":
      return issue.exported ? "exported but never imported" : "declared but never used";
    case "unused-export":
      return `only used in this file (${issue.localUses} local use${issue.localUses === 1 ? "" : "s"})`;
    case "empty-wrapper":
      return `→ ${issue.innerCall}; passes args unchanged`;
    case "useless-type-predicate":
      return `collapses to ${issue.collapsesTo}`;
    case "same-shape-types": {
      const names = [issue.primaryName, ...issue.matchNames].join(" / ");
      return `${names} share ${issue.fieldCount}-field shape`;
    }
    case "useless-async":
      return "async without await; can drop async";
    case "empty-catch":
      if (issue.rethrowsOnly) return "catch only rethrows; the try/catch adds nothing";
      return issue.swallowsAll ? "swallows every error silently" : "catch block does nothing";
    case "duplicate": {
      const others = issue.matches
        .map((m) => relativePath(m.file, rootDir) + ":" + m.line)
        .join(", ");
      return `${Math.round(issue.similarity * 100)}% similar to ${others}`;
    }
  }
}

function formatAnchorPath(
  anchor: Location | string,
  rootDir: string,
  opts: Pick<RenderOptions, "color" | "hyperlinks">,
): string {
  const c = makeColors(opts.color);
  if (typeof anchor === "string") {
    const rel = relativePath(anchor, rootDir);
    const text = c.underline(rel);
    return opts.hyperlinks ? hyperlink(`file://${anchor.replace(/\\/g, "/")}`, text) : text;
  }
  return formatFilePathHeader(anchor.file, rootDir, opts);
}

function formatFilePathHeader(
  file: string,
  rootDir: string,
  opts: Pick<RenderOptions, "color" | "hyperlinks">,
): string {
  const c = makeColors(opts.color);
  const rel = relativePath(file, rootDir);
  const text = c.bold(c.underline(rel));
  return opts.hyperlinks ? hyperlink(`file://${file.replace(/\\/g, "/")}`, text) : text;
}

function relativePath(file: string, rootDir: string): string {
  return relative(rootDir, file).replace(/\\/g, "/") || file;
}

function renderConfidence(confidence: number, color: boolean): string {
  const c = makeColors(color);
  const text = confidence.toFixed(2);
  if (confidence >= 0.8) return c.green(text);
  if (confidence >= 0.5) return c.yellow(text);
  return c.dim(text);
}

function hyperlink(uri: string, text: string): string {
  const ESC = "\x1b";
  const ST = `${ESC}\\`;
  return `${ESC}]8;;${uri}${ST}${text}${ESC}]8;;${ST}`;
}

function padEnd(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}

function sortIssues(issues: Issue[]): Issue[] {
  const order: Record<Issue["kind"], number> = {
    "dead-code": 0,
    "unused-export": 1,
    "empty-wrapper": 2,
    "useless-async": 3,
    "empty-catch": 4,
    "useless-type-predicate": 5,
    duplicate: 6,
    "same-shape-types": 7,
  };
  return [...issues].sort((a, b) => {
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
    return primaryLine(a) - primaryLine(b);
  });
}

function primaryLocation(i: Issue): Location {
  switch (i.kind) {
    case "duplicate":
    case "same-shape-types":
      return i.primary;
    default:
      return i.location;
  }
}

function primaryFile(i: Issue): string {
  return primaryLocation(i).file;
}

function primaryLine(i: Issue): number {
  return primaryLocation(i).line;
}

export function renderIssue(
  issue: Issue,
  rootDir: string,
  opts: Pick<RenderOptions, "color" | "hyperlinks">,
): string {
  return `${formatFilePathHeader(primaryFile(issue), rootDir, opts)}\n${renderIssueLine(issue, rootDir, opts)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatFileCount(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

function makeColors(enabled: boolean): typeof pc {
  if (enabled) return pc;
  const identity = (s: string) => s;
  return new Proxy(pc, {
    get() {
      return identity;
    },
  });
}
