import { type Identifier, Node, type SourceFile, SyntaxKind, type Symbol } from "ts-morph";

export interface ReferencesCache {
  refsOf(symbol: Symbol): Identifier[];
}

const ALIAS_FLAG = 0x200000;

const DECLARATION_NAME_PARENT_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PropertyAssignment,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.PropertySignature,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.EnumMember,
  SyntaxKind.Parameter,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.TypeParameter,
  SyntaxKind.BindingElement,
  SyntaxKind.JsxAttribute,
]);

export function buildReferencesCache(files: SourceFile[]): ReferencesCache {
  const byId = new Map<number, Identifier[]>();

  for (const sf of files) {
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!isReferenceForm(id)) continue;
      const sym = canonicalSymbol(id);
      if (!sym) continue;
      const key = symbolIdOf(sym);
      const arr = byId.get(key);
      if (arr) arr.push(id);
      else byId.set(key, [id]);
    }
  }

  return {
    refsOf(symbol: Symbol): Identifier[] {
      return byId.get(symbolIdOf(canonicalSymbolOf(symbol))) ?? [];
    },
  };
}

function canonicalSymbol(id: Identifier): Symbol | undefined {
  const direct = safeGetSymbol(id);
  if (!direct) return undefined;
  if (!isInImportOrReexportPosition(id)) return direct;
  return canonicalSymbolOf(direct);
}

function isInImportOrReexportPosition(id: Identifier): boolean {
  let cur: Node | undefined = id.getParent();
  for (let i = 0; cur && i < 4; i++) {
    if (
      Node.isImportSpecifier(cur) ||
      Node.isImportClause(cur) ||
      Node.isNamespaceImport(cur) ||
      Node.isImportEqualsDeclaration(cur) ||
      Node.isExportSpecifier(cur)
    ) {
      return true;
    }
    cur = cur.getParent();
  }
  return false;
}

function canonicalSymbolOf(sym: Symbol): Symbol {
  let cursor: Symbol = sym;
  for (let i = 0; i < 16; i++) {
    if (!isAlias(cursor)) return cursor;
    const next = safeGetAliased(cursor);
    if (!next || next === cursor) return cursor;
    cursor = next;
  }
  return cursor;
}

function isAlias(sym: Symbol): boolean {
  return (sym.getFlags() & ALIAS_FLAG) !== 0;
}

function safeGetAliased(sym: Symbol): Symbol | undefined {
  try {
    return sym.getAliasedSymbol();
  } catch {
    return undefined;
  }
}

function isReferenceForm(id: Identifier): boolean {
  const parent = id.getParent();
  if (!parent) return true;
  if (!DECLARATION_NAME_PARENT_KINDS.has(parent.getKind())) return true;
  const maybe = parent as unknown as { getNameNode?: () => Node | undefined };
  const nameOf = typeof maybe.getNameNode === "function" ? maybe.getNameNode() : undefined;
  return nameOf !== id;
}

function safeGetSymbol(id: Identifier): Symbol | undefined {
  try {
    return id.getSymbol();
  } catch {
    return undefined;
  }
}

const symbolIds = new WeakMap<object, number>();
let nextSymbolId = 1;

function symbolIdOf(sym: Symbol): number {
  const compilerSymbol = sym.compilerSymbol as unknown as object;
  let id = symbolIds.get(compilerSymbol);
  if (id === undefined) {
    id = nextSymbolId++;
    symbolIds.set(compilerSymbol, id);
  }
  return id;
}
