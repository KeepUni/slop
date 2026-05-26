import {
  type Diagnostic,
  Node,
  type Project,
  type SourceFile,
  type Statement,
  type VariableDeclaration,
} from "ts-morph";
import type { DeadCodeIssue } from "../detectors/types.js";

export interface FixPlan {
  file: string;
  symbol: string;
  symbolKind: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface FixResult {
  filesChanged: number;
  removedSymbols: Array<{ file: string; symbol: string }>;
  rolledBack: boolean;
  brokenBy: Array<{ file: string; line: number; message: string; symbol: string }>;
}

const BROKEN_REF_CODES = new Set([
  2304, // Cannot find name 'X'
  2305, // Module 'Y' has no exported member 'X'
  2552, // Cannot find name 'X'. Did you mean 'Z'?
  2724, // 'Y' has no exported member named 'X'. Did you mean 'Z'?
]);

export function planDeadCodeFixes(project: Project, issues: DeadCodeIssue[]): FixPlan[] {
  const out: FixPlan[] = [];
  for (const issue of issues) {
    const sf = project.getSourceFile(issue.location.file);
    if (!sf) continue;
    const target = findStatementBySymbol(sf, issue.symbol);
    if (!target) continue;
    const node = target.kind === "variable" ? target.declaration : target.statement;
    const start = node.getStart();
    const end = node.getEnd();
    const { line: startLine } = sf.getLineAndColumnAtPos(start);
    const { line: endLine } = sf.getLineAndColumnAtPos(end);
    out.push({
      file: issue.location.file,
      symbol: issue.symbol,
      symbolKind: issue.symbolKind,
      startLine,
      endLine,
      snippet: extractLines(sf.getFullText(), startLine, endLine),
    });
  }
  return out;
}

export interface PendingFix {
  project: Project;
  snapshots: Map<string, string>;
  removedSymbols: Array<{ file: string; symbol: string }>;
  filesChanged: number;
}

export interface PreparedFixResult {
  rolledBack: boolean;
  brokenBy: FixResult["brokenBy"];
  pending?: PendingFix;
}

// in-memory removal + ts diagnostic verify. caller must commit or rollback.
export function prepareDeadCodeFixes(
  project: Project,
  issues: DeadCodeIssue[],
): PreparedFixResult {
  const removedSymbols: Array<{ file: string; symbol: string }> = [];
  const changedFiles = new Set<string>();
  const snapshots = new Map<string, string>();
  const baselineDiagnostics = snapshotDiagnosticKeys(project);

  for (const issue of issues) {
    const sf = project.getSourceFile(issue.location.file);
    if (!sf) continue;
    if (!snapshots.has(issue.location.file)) {
      snapshots.set(issue.location.file, sf.getFullText());
    }

    const target = findStatementBySymbol(sf, issue.symbol);
    if (!target) continue;

    if (target.kind === "variable") {
      const stmt = target.declaration.getVariableStatement();
      const declList = stmt?.getDeclarationList();
      if (declList && declList.getDeclarations().length > 1) {
        target.declaration.remove();
      } else {
        stmt?.remove();
      }
    } else {
      target.statement.remove();
    }

    removedSymbols.push({ file: issue.location.file, symbol: issue.symbol });
    changedFiles.add(issue.location.file);
  }

  for (const file of changedFiles) {
    const sf = project.getSourceFile(file);
    if (!sf) continue;
    sf.fixUnusedIdentifiers();
  }

  const brokenBy = findBrokenReferences(project, baselineDiagnostics, removedSymbols);
  if (brokenBy.length > 0) {
    restoreSnapshots(project, snapshots);
    return { rolledBack: true, brokenBy };
  }

  return {
    rolledBack: false,
    brokenBy: [],
    pending: {
      project,
      snapshots,
      removedSymbols,
      filesChanged: changedFiles.size,
    },
  };
}

// only safe after every prepared fix in the batch came back rolledBack=false.
export async function commitDeadCodeFixes(pending: PendingFix): Promise<void> {
  await pending.project.save();
}

export function rollbackPendingFixes(pending: PendingFix): void {
  restoreSnapshots(pending.project, pending.snapshots);
}

function restoreSnapshots(project: Project, snapshots: Map<string, string>): void {
  for (const [file, originalText] of snapshots) {
    const sf = project.getSourceFile(file);
    if (sf) sf.replaceWithText(originalText);
  }
}

export async function applyDeadCodeFixes(
  project: Project,
  issues: DeadCodeIssue[],
): Promise<FixResult> {
  const prepared = prepareDeadCodeFixes(project, issues);
  if (prepared.rolledBack) {
    return {
      filesChanged: 0,
      removedSymbols: [],
      rolledBack: true,
      brokenBy: prepared.brokenBy,
    };
  }
  const pending = prepared.pending;
  if (!pending) {
    return { filesChanged: 0, removedSymbols: [], rolledBack: false, brokenBy: [] };
  }
  await commitDeadCodeFixes(pending);
  return {
    filesChanged: pending.filesChanged,
    removedSymbols: pending.removedSymbols,
    rolledBack: false,
    brokenBy: [],
  };
}

function snapshotDiagnosticKeys(project: Project): Set<string> {
  const out = new Set<string>();
  for (const d of project.getPreEmitDiagnostics()) {
    out.add(diagnosticKey(d));
  }
  return out;
}

function diagnosticKey(d: Diagnostic): string {
  const sf = d.getSourceFile();
  return `${sf?.getFilePath() ?? "?"}:${d.getStart() ?? 0}:${d.getCode()}`;
}

function findBrokenReferences(
  project: Project,
  baselineKeys: Set<string>,
  removedSymbols: FixResult["removedSymbols"],
): FixResult["brokenBy"] {
  if (removedSymbols.length === 0) return [];
  const removedNames = new Set(removedSymbols.map((r) => r.symbol));
  const broken: FixResult["brokenBy"] = [];
  for (const d of project.getPreEmitDiagnostics()) {
    if (baselineKeys.has(diagnosticKey(d))) continue;
    if (!BROKEN_REF_CODES.has(d.getCode())) continue;
    const message = flattenDiagnosticMessage(d.getMessageText());
    const symbol = [...removedNames].find((name) =>
      message.includes(`'${name}'`) || message.includes(`"${name}"`),
    );
    if (!symbol) continue;
    const sf = d.getSourceFile();
    const start = d.getStart() ?? 0;
    const { line } = sf?.getLineAndColumnAtPos(start) ?? { line: 0 };
    broken.push({
      file: sf?.getFilePath() ?? "?",
      line,
      message,
      symbol,
    });
  }
  return broken;
}

function flattenDiagnosticMessage(m: string | { getMessageText(): string }): string {
  return typeof m === "string" ? m : m.getMessageText();
}

function extractLines(source: string, startLine: number, endLine: number): string {
  const all = source.split(/\r?\n/);
  return all.slice(startLine - 1, endLine).join("\n");
}

type Hit =
  | { kind: "statement"; statement: Statement }
  | { kind: "variable"; declaration: VariableDeclaration };

function findStatementBySymbol(sf: SourceFile, symbol: string): Hit | undefined {
  for (const stmt of sf.getStatements()) {
    if (
      Node.isFunctionDeclaration(stmt) ||
      Node.isClassDeclaration(stmt) ||
      Node.isInterfaceDeclaration(stmt) ||
      Node.isTypeAliasDeclaration(stmt) ||
      Node.isEnumDeclaration(stmt)
    ) {
      if (stmt.getName() === symbol) return { kind: "statement", statement: stmt };
    } else if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarations()) {
        const nameNode = decl.getNameNode();
        if (Node.isIdentifier(nameNode) && nameNode.getText() === symbol) {
          return { kind: "variable", declaration: decl };
        }
      }
    }
  }
  return undefined;
}
