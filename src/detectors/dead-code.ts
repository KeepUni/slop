import { relative } from "node:path";
import {
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type Identifier,
  type InterfaceDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
  type TypeAliasDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import { isGeneratedFilePath, isGeneratedSource, isTestFilePath } from "../core/config.js";
import { collectEntryPoints, collectTemplateConsumption } from "../core/entry-points.js";
import {
  CONSUMED_ALL,
  discoverWorkspacePackages,
  resolveWorkspaceTarget,
  type WorkspacePackage,
} from "../core/monorepo.js";
import { safeGetSpecifierValue } from "../utils/ast.js";
import type {
  Detector,
  DetectorContext,
  Issue,
  Location,
  SymbolKind,
  UnusedExportIssue,
} from "./types.js";

type NamedDeclaration =
  | FunctionDeclaration
  | ClassDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | EnumDeclaration
  | VariableDeclaration;

const FRAMEWORK_CONVENTION_FILE =
  /(^|\/)(app|pages|routes)\/|(^|\/)middleware\.|(^|\/)instrumentation\.|\.config\.(ts|js|mjs|cjs)$/;

export const deadCodeDetector: Detector = {
  name: "dead-code",
  async run(ctx: DetectorContext): Promise<Issue[]> {
    const entryPoints = collectEntryPoints(ctx.files, ctx.rootDir);
    const templateConsumed = collectTemplateConsumption(ctx.rootDir, ctx.files);
    const allowJs = ctx.project.getCompilerOptions().allowJs === true;
    const workspacePackages = discoverWorkspacePackages(ctx.rootDir);
    const aliasIndex = buildAliasedImportIndex(ctx.files, workspacePackages);
    const externallyConsumed = ctx.externallyConsumed ?? new Set<string>();

    const issues: Issue[] = [];
    for (const sf of ctx.files) {
      const filePath = sf.getFilePath();
      if (entryPoints.has(filePath)) continue;
      if (!allowJs && /\.[mc]?jsx?$/i.test(filePath)) continue;
      if (isTestFilePath(filePath, ctx.rootDir)) continue;
      if (isGeneratedFilePath(filePath)) continue;
      if (isGeneratedSource(sf.getFullText())) continue;
      const templateNames =
        templateConsumed.namedSymbolsByFile.get(filePath.replace(/\\/g, "/")) ?? new Set<string>();
      collectFromFile(
        sf,
        ctx.rootDir,
        ctx.refs,
        templateNames,
        aliasIndex,
        externallyConsumed,
        issues,
      );
    }
    return issues;
  },
};

interface AliasedImportIndex {
  importsFor(symbolName: string, declFile: string): boolean;
}

function buildAliasedImportIndex(
  files: SourceFile[],
  workspacePackages: WorkspacePackage[],
): AliasedImportIndex {
  const byTail = new Map<string, Set<string>>();
  const byWorkspaceDir = new Map<string, Set<string>>();
  const workspaceByName = new Map<string, string>();
  for (const pkg of workspacePackages) workspaceByName.set(pkg.name, pkg.dir);

  const strippedPaths = files.map((sf) =>
    sf.getFilePath().replace(/\\/g, "/").replace(/\.(tsx?|jsx?|mjs|cjs)$/, ""),
  );
  const tailMatchCount = (tail: string): number => {
    let count = 0;
    for (const fp of strippedPaths) {
      if (fp.endsWith(`/${tail}`) || fp.endsWith(`/${tail}/index`)) count++;
      if (count > 1) return count;
    }
    return count;
  };

  const record = (clauseNames: string[], spec: string) => {
    if (clauseNames.length === 0) return;
    const workspaceDir = resolveWorkspaceTarget(spec, workspaceByName);
    if (workspaceDir) {
      const set = byWorkspaceDir.get(workspaceDir) ?? new Set<string>();
      for (const n of clauseNames) set.add(n);
      byWorkspaceDir.set(workspaceDir, set);
      return;
    }
    const tail = aliasPathTail(spec);
    if (!tail) return;
    // single-segment tails are recorded only if unambiguous — multiple files
    // sharing a basename (common in monorepos) would otherwise bridge them.
    if (!tail.includes("/") && tailMatchCount(tail) !== 1) return;
    for (const n of clauseNames) addToIndex(byTail, n, tail);
  };

  for (const sf of files) {
    for (const imp of sf.getImportDeclarations()) {
      const spec = safeGetSpecifierValue(imp);
      if (!spec || spec.startsWith(".")) continue;
      const clause = imp.getImportClause();
      if (!clause) continue;
      const names: string[] = [];
      const def = clause.getDefaultImport();
      if (def) names.push(def.getText());
      const ns = clause.getNamespaceImport();
      if (ns) names.push(ns.getText());
      for (const named of clause.getNamedImports()) {
        const original = namedSpecifierOriginal(named);
        if (original) names.push(original);
      }
      record(names, spec);
    }
    for (const exp of sf.getExportDeclarations()) {
      if (!exp.hasModuleSpecifier()) continue;
      const spec = safeGetSpecifierValue(exp);
      if (!spec || spec.startsWith(".")) continue;
      const names: string[] = [];
      for (const named of exp.getNamedExports()) {
        const original = namedSpecifierOriginal(named);
        if (original) names.push(original);
      }
      record(names, spec);
    }
  }

  return {
    importsFor(symbolName: string, declFile: string): boolean {
      const norm = declFile.replace(/\\/g, "/");
      for (const [workspaceDir, names] of byWorkspaceDir) {
        if (names.has(symbolName) && norm.startsWith(`${workspaceDir}/`)) return true;
      }
      const tails = byTail.get(symbolName);
      if (!tails || tails.size === 0) return false;
      const stripped = norm.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
      for (const tail of tails) {
        if (stripped.endsWith(`/${tail}`) || stripped.endsWith(`/${tail}/index`)) return true;
      }
      return false;
    },
  };
}

function namedSpecifierOriginal(named: unknown): string | undefined {
  if (!named || typeof named !== "object") return undefined;
  const n = named as {
    getPropertyNameNode?: () => { getText: () => string } | undefined;
    getNameNode?: () => { getText: () => string };
  };
  if (typeof n.getPropertyNameNode === "function") {
    const prop = n.getPropertyNameNode();
    if (prop) return prop.getText();
  }
  if (typeof n.getNameNode === "function") return n.getNameNode().getText();
  return undefined;
}

// only TS path-alias forms (`@/`, `~/`, `#/`, `$/`); npm-scoped specs return undefined.
function aliasPathTail(spec: string): string | undefined {
  const aliasMatch = spec.match(/^([@~#$])\//);
  if (!aliasMatch) return undefined;
  const tail = spec.slice(aliasMatch[0].length).replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  if (!tail) return undefined;
  return tail;
}

function addToIndex(byName: Map<string, Set<string>>, name: string, tail: string): void {
  const set = byName.get(name);
  if (set) set.add(tail);
  else byName.set(name, new Set([tail]));
}

const PUBLICATION_DIR_RE =
  /[\\/](?:registry|styles|themes|variants|templates?|examples|presets|demos|icons|assets)[\\/]/i;

function collectFromFile(
  sf: SourceFile,
  rootDir: string,
  refs: DetectorContext["refs"],
  templateConsumedNames: Set<string>,
  aliasIndex: AliasedImportIndex,
  externallyConsumed: ReadonlySet<string>,
  out: Issue[],
): void {
  const filePath = sf.getFilePath();
  const inPublicationDir = PUBLICATION_DIR_RE.test(filePath);
  const seenSymbols = new Set<string>();
  for (const decl of topLevelDeclarations(sf)) {
    const nameNode = getNameNode(decl);
    if (!nameNode) continue;
    const symbolName = nameNode.getText();
    if (seenSymbols.has(symbolName)) continue;
    if (symbolName.startsWith("_")) continue;
    if (templateConsumedNames.has(symbolName)) continue;
    if (Node.isClassDeclaration(decl) && classCarriesDecorators(decl)) continue;
    seenSymbols.add(symbolName);

    const declStart = nameNode.getStart();
    const sym = safeGetSymbol(nameNode);
    const cachedRefs = sym ? refs.refsOf(sym) : [];
    const nonDeclCached = cachedRefs.filter(
      (r) => r.getStart() !== declStart || r.getSourceFile() !== sf,
    );

    let nonDeclRefs: Node[];
    if (nonDeclCached.length > 0) {
      nonDeclRefs = nonDeclCached;
    } else {
      const authoritativeRefs = safeFindReferences(nameNode);
      nonDeclRefs = authoritativeRefs.filter(
        (r) => r.getStart() !== declStart || r.getSourceFile() !== sf,
      );
    }

    const exported = isExported(decl);
    const crossFileRefs = nonDeclRefs.filter((r) => r.getSourceFile() !== sf);

    const aliasImported =
      exported && aliasIndex.importsFor(symbolName, sf.getFilePath());

    if (nonDeclRefs.length === 0 && aliasImported) continue;
    if (
      exported &&
      (externallyConsumed.has(CONSUMED_ALL) || externallyConsumed.has(symbolName))
    ) {
      continue;
    }

    if (nonDeclRefs.length === 0) {
      out.push({
        kind: "dead-code",
        location: locationOf(decl, nameNode),
        symbol: symbolName,
        symbolKind: kindOf(decl),
        exported,
        confidence: scoreDeadCode(decl, sf, rootDir, exported),
      });
    } else if (exported && crossFileRefs.length === 0) {
      if (aliasImported) continue;
      if (inPublicationDir) continue;
      const localUses = nonDeclRefs.length;
      const unusedExport: UnusedExportIssue = {
        kind: "unused-export",
        location: locationOf(decl, nameNode),
        symbol: symbolName,
        symbolKind: kindOf(decl),
        localUses,
        confidence: scoreUnusedExport(decl, sf, rootDir),
      };
      out.push(unusedExport);
    }
  }
}

function scoreDeadCode(
  decl: NamedDeclaration,
  sf: SourceFile,
  rootDir: string,
  exported: boolean,
): number {
  let score = 0.9;
  if (isDefaultExport(decl)) score -= 0.2;
  const rel = relative(rootDir, sf.getFilePath()).replace(/\\/g, "/");
  if (FRAMEWORK_CONVENTION_FILE.test(rel)) score -= 0.4;
  if (!exported) score += 0.05;
  return clamp01(score);
}

function scoreUnusedExport(decl: NamedDeclaration, sf: SourceFile, rootDir: string): number {
  let score = 0.75;
  if (isDefaultExport(decl)) score -= 0.2;
  const rel = relative(rootDir, sf.getFilePath()).replace(/\\/g, "/");
  if (FRAMEWORK_CONVENTION_FILE.test(rel)) score -= 0.4;
  return clamp01(score);
}

function isDefaultExport(decl: NamedDeclaration): boolean {
  const maybe = decl as unknown as { isDefaultExport?: () => boolean };
  return typeof maybe.isDefaultExport === "function" ? maybe.isDefaultExport() : false;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function classCarriesDecorators(cls: ClassDeclaration): boolean {
  return cls.getDescendantsOfKind(SyntaxKind.Decorator).length > 0;
}

function topLevelDeclarations(sf: SourceFile): NamedDeclaration[] {
  const decls: NamedDeclaration[] = [];
  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) decls.push(stmt);
    else if (Node.isClassDeclaration(stmt)) decls.push(stmt);
    else if (Node.isInterfaceDeclaration(stmt)) decls.push(stmt);
    else if (Node.isTypeAliasDeclaration(stmt)) decls.push(stmt);
    else if (Node.isEnumDeclaration(stmt)) decls.push(stmt);
    else if (Node.isVariableStatement(stmt)) {
      for (const d of stmt.getDeclarations()) decls.push(d);
    }
  }
  return decls;
}

function getNameNode(decl: NamedDeclaration): Identifier | undefined {
  if (Node.isVariableDeclaration(decl)) {
    const nameNode = decl.getNameNode();
    return Node.isIdentifier(nameNode) ? nameNode : undefined;
  }
  const nameNode = decl.getNameNode();
  if (!nameNode) return undefined;
  return Node.isIdentifier(nameNode) ? nameNode : undefined;
}

function safeGetSymbol(node: Identifier): ReturnType<Identifier["getSymbol"]> {
  try {
    return node.getSymbol();
  } catch {
    return undefined;
  }
}

function safeFindReferences(node: Identifier): ReturnType<Identifier["findReferencesAsNodes"]> {
  try {
    return node.findReferencesAsNodes();
  } catch {
    return [];
  }
}

function isExported(decl: NamedDeclaration): boolean {
  if (Node.isVariableDeclaration(decl)) {
    return decl.getVariableStatement()?.isExported() ?? false;
  }
  const maybe = decl as unknown as { isExported?: () => boolean };
  return typeof maybe.isExported === "function" ? maybe.isExported() : false;
}

function kindOf(decl: NamedDeclaration): SymbolKind {
  if (Node.isFunctionDeclaration(decl)) return "function";
  if (Node.isClassDeclaration(decl)) return "class";
  if (Node.isEnumDeclaration(decl)) return "enum";
  if (Node.isInterfaceDeclaration(decl) || Node.isTypeAliasDeclaration(decl)) return "type";
  return "variable";
}

function locationOf(decl: NamedDeclaration, nameNode: Identifier): Location {
  const sf = decl.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(nameNode.getStart());
  return { file: sf.getFilePath(), line, column };
}
