#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import pc from "picocolors";
import { FIX_MIN_CONFIDENCE } from "./core/config.js";
import { isMonorepo } from "./core/monorepo.js";
import { findProjectRoot } from "./core/project.js";
import { scan, scanMonorepo, type ScanResult } from "./core/scanner.js";
import type { DeadCodeIssue, DetectorName, Issue } from "./detectors/types.js";
import {
  applyDeadCodeFixes,
  commitDeadCodeFixes,
  type FixPlan,
  type PendingFix,
  planDeadCodeFixes,
  prepareDeadCodeFixes,
  rollbackPendingFixes,
} from "./fixers/dead-code.js";
import { groupBy } from "./utils/group.js";
import { toJson } from "./reporters/json.js";
import { renderHeader, renderResult } from "./reporters/terminal.js";

const VERSION = readPackageVersion();

interface CliOptions {
  fix: boolean;
  json: boolean;
  only?: DetectorName;
  ignore?: string[];
  color: boolean;
  yes: boolean;
  minConfidence?: string;
  verbose: boolean;
}

const program = new Command();

program
  .name("slp")
  .description(
    "Static analysis for JS/TS: dead exports, duplicates, empty wrappers (incl. JSX), useless type predicates, same-shape types, useless async, empty catch, plus cross-detector insights.",
  )
  .version(VERSION, "-v, --version", "show version")
  .argument("[paths...]", "files or folders to scan (defaults to current directory)")
  .option("--fix", "remove dead-code items (diff preview + TS verify before write)", false)
  .option("--json", "machine-readable JSON output", false)
  .addOption(
    new Option("--only <detector>", "run only one detector").choices([
      "duplicates",
      "dead-code",
      "empty-wrappers",
      "ai-signatures",
      "code-smells",
    ]),
  )
  .option("--ignore <patterns...>", "extra glob patterns to ignore")
  .option("--min-confidence <n>", "hide findings with confidence below n (0..1, default 0.7)")
  .option("--verbose", "show single-detector issues that were rolled up into insights", false)
  .option("--no-color", "disable ANSI colors")
  .option("-y, --yes", "skip confirmation prompts", false)
  .action(async (paths: string[], options: CliOptions) => {
    const color = resolveColor(options.color);
    const hyperlinks = color && supportsHyperlinks();
    const cwd = process.cwd();
    const targetLabel = paths.length > 0 ? paths.join(" ") : ".";

    if (!options.json) {
      process.stdout.write(
        renderHeader({ color, hyperlinks, version: VERSION, targetLabel, deadCodeFixable: 0 }),
      );
      process.stdout.write("\n");
    }

    const monorepoRoot = findProjectRoot(paths.length > 0 ? resolve(cwd, paths[0]) : cwd);
    const inMonorepo = isMonorepo(monorepoRoot);
    if (inMonorepo && !options.json) {
      const dim = color ? pc.dim : (s: string) => s;
      const yellow = color ? pc.yellow : (s: string) => s;
      process.stdout.write(
        `  ${yellow("monorepo (beta)")} ${dim("— per-package scan with per-symbol cross-package resolution")}\n\n`,
      );
    }

    const minConfidence = parseMinConfidence(options.minConfidence);
    const baseOptions = {
      rootDir: cwd,
      paths,
      only: options.only ? [options.only] : undefined,
      ignore: options.ignore,
      color,
      minConfidence,
      verbose: options.verbose,
    };
    const scansWholeRepo =
      paths.length === 0 ||
      paths.every((p) => p === "." || resolve(cwd, p) === monorepoRoot);
    const result =
      inMonorepo && scansWholeRepo
        ? await scanMonorepo(baseOptions)
        : await scan(baseOptions);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(toJson(result), null, 2)}\n`);
      process.exit(result.issues.length === 0 && result.insights.length === 0 ? 0 : 1);
    }

    const fixableDead = result.issues
      .filter(isDeadCode)
      .filter((i) => i.confidence >= FIX_MIN_CONFIDENCE);
    process.stdout.write(
      renderResult(result, {
        color,
        hyperlinks,
        version: VERSION,
        targetLabel,
        deadCodeFixable: options.fix ? 0 : fixableDead.length,
      }),
    );

    if (options.fix && fixableDead.length > 0) {
      await runFix(result, fixableDead, result.rootDir, color, options.yes);
    }

    process.exit(result.issues.length === 0 && result.insights.length === 0 ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${pc.red("slp: fatal error")}\n${formatError(err)}\n`);
  process.exit(2);
});

function isDeadCode(i: Issue): i is DeadCodeIssue {
  return i.kind === "dead-code";
}

function parseMinConfidence(raw: string | undefined): number {
  if (raw === undefined || raw === null) return 0.7;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`--min-confidence must be a number in [0, 1], got: ${JSON.stringify(raw)}`);
  }
  return n;
}

const FIX_SNIPPET_MAX_LINES = 6;

async function runFix(
  result: ScanResult,
  issues: DeadCodeIssue[],
  rootDir: string,
  color: boolean,
  autoYes: boolean,
): Promise<void> {
  const c = color ? pc : noColors();
  const groups = groupIssuesByProject(result, issues);
  const allPlans: FixPlan[] = [];
  for (const [proj, groupIssues] of groups) {
    allPlans.push(...planDeadCodeFixes(proj, groupIssues));
  }
  if (allPlans.length === 0) {
    process.stdout.write(`${c.dim("nothing to fix")}\n`);
    return;
  }

  renderFixPreview(allPlans, rootDir, c);

  if (!autoYes && process.stdin.isTTY) {
    const ok = await confirm("proceed?");
    if (!ok) {
      process.stdout.write(`${c.dim("aborted, nothing changed")}\n`);
      return;
    }
  }

  process.stdout.write(`${c.dim("verifying TypeScript after removal...")}\n`);

  // verify every group in memory first; commit ONLY if all passed. otherwise
  // every prepared group is rolled back — atomicity across workspace packages.
  const pendingFixes: PendingFix[] = [];
  const allBroken: Array<{ file: string; line: number; message: string; symbol: string }> = [];
  let totalRemoved = 0;
  let totalFilesChanged = 0;

  for (const [proj, groupIssues] of groups) {
    const prepared = prepareDeadCodeFixes(proj, groupIssues);
    if (prepared.rolledBack) {
      allBroken.push(...prepared.brokenBy);
      continue;
    }
    if (prepared.pending) {
      pendingFixes.push(prepared.pending);
      totalRemoved += prepared.pending.removedSymbols.length;
      totalFilesChanged += prepared.pending.filesChanged;
    }
  }

  if (allBroken.length > 0) {
    for (const pending of pendingFixes) rollbackPendingFixes(pending);
    process.stdout.write(
      `${c.bold(c.red("aborted"))}: removal would break ${allBroken.length} reference${allBroken.length === 1 ? "" : "s"} -- nothing was written to disk\n`,
    );
    for (const b of allBroken.slice(0, 5)) {
      const rel = relativeForDisplay(b.file, rootDir);
      process.stdout.write(
        `  ${c.bold(rel)}${c.dim(":")}${b.line}  ${c.dim(`(${b.symbol})`)}  ${b.message}\n`,
      );
    }
    if (allBroken.length > 5) {
      process.stdout.write(`  ${c.dim(`...and ${allBroken.length - 5} more`)}\n`);
    }
    return;
  }

  for (const pending of pendingFixes) await commitDeadCodeFixes(pending);

  process.stdout.write(
    `${c.green("removed")} ${totalRemoved} item${totalRemoved === 1 ? "" : "s"} across ${totalFilesChanged} file${totalFilesChanged === 1 ? "" : "s"}\n`,
  );
}

function groupIssuesByProject(
  result: ScanResult,
  issues: DeadCodeIssue[],
): Map<Parameters<typeof applyDeadCodeFixes>[0], DeadCodeIssue[]> {
  const groups = new Map<Parameters<typeof applyDeadCodeFixes>[0], DeadCodeIssue[]>();
  for (const issue of issues) {
    const proj = result.projectForFile(issue.location.file) ?? result.project;
    const arr = groups.get(proj) ?? [];
    arr.push(issue);
    groups.set(proj, arr);
  }
  return groups;
}

function renderFixPreview(plans: FixPlan[], rootDir: string, c: typeof pc): void {
  process.stdout.write(
    `${c.bold("--fix")}  ${plans.length} dead-code item${plans.length === 1 ? "" : "s"} will be removed:\n\n`,
  );
  for (const [file, items] of groupBy(plans, (p) => p.file)) {
    const rel = relativeForDisplay(file, rootDir);
    process.stdout.write(`  ${c.bold(c.underline(rel))}\n`);
    for (const p of items) {
      const lines = p.snippet.split("\n");
      const truncated = lines.length > FIX_SNIPPET_MAX_LINES;
      const shown = truncated ? lines.slice(0, FIX_SNIPPET_MAX_LINES) : lines;
      for (const line of shown) {
        process.stdout.write(`    ${c.red("-")} ${c.red(line)}\n`);
      }
      if (truncated) {
        process.stdout.write(
          `      ${c.dim(`...${lines.length - FIX_SNIPPET_MAX_LINES} more line${lines.length - FIX_SNIPPET_MAX_LINES === 1 ? "" : "s"}`)}\n`,
        );
      }
    }
    process.stdout.write("\n");
  }
}

function relativeForDisplay(file: string, rootDir: string): string {
  const norm = file.replace(/\\/g, "/");
  const root = rootDir.replace(/\\/g, "/");
  if (norm.startsWith(`${root}/`)) return norm.slice(root.length + 1);
  return norm;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolveConfirm) => {
    process.stdout.write(`${question} [y/N] `);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      const answer = String(data).trim().toLowerCase();
      resolveConfirm(answer === "y" || answer === "yes");
    });
  });
}

function noColors(): typeof pc {
  const id = (s: string) => s;
  return new Proxy(pc, { get: () => id });
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function resolveColor(flag: boolean | undefined): boolean {
  if (flag === false) return false;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "") return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return false;
    return true;
  }
  return process.stdout.isTTY === true;
}

function supportsHyperlinks(): boolean {
  if (process.env.NO_HYPERLINKS) return false;
  if (process.env.FORCE_HYPERLINKS) return true;
  if ((process.env.TERM_PROGRAM ?? "") === "Apple_Terminal") return false;
  if (process.env.CI) return false;
  return process.stdout.isTTY === true;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
