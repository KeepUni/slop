import { relative } from "node:path";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MethodSignature,
  type MethodDeclaration,
  Node,
  type PropertySignature,
  type SourceFile,
  type TypeAliasDeclaration,
  type TypeLiteralNode,
} from "ts-morph";
import { isGeneratedFilePath, isGeneratedSource, isTestFilePath } from "../core/config.js";
import { getNamedFunctionAnchor } from "../utils/ast.js";
import type {
  Detector,
  DetectorContext,
  Issue,
  Location,
  SameShapeTypesIssue,
  UselessTypePredicateIssue,
} from "./types.js";

type FunctionLike = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

const BUILTIN_TYPEOF_LITERALS = new Set([
  "string",
  "number",
  "boolean",
  "undefined",
  "function",
  "object",
  "symbol",
  "bigint",
]);

const SAME_SHAPE_MIN_FIELDS = 3;

const LAYERED_ARCH_RE =
  /(^|\/)(dto|model|models|view|views|entity|entities|schema|schemas)\//;

export const aiSignaturesDetector: Detector = {
  name: "ai-signatures",
  async run(ctx: DetectorContext): Promise<Issue[]> {
    const out: Issue[] = [];
    const productionFiles = ctx.files.filter((sf) => {
      const fp = sf.getFilePath();
      if (isTestFilePath(fp, ctx.rootDir)) return false;
      if (isGeneratedFilePath(fp)) return false;
      if (isGeneratedSource(sf.getFullText())) return false;
      return true;
    });
    for (const sf of productionFiles) collectUselessTypePredicates(sf, out);
    collectSameShapeTypes(productionFiles, ctx.rootDir, out);
    return out;
  },
};

function collectUselessTypePredicates(sf: SourceFile, out: Issue[]): void {
  sf.forEachDescendant((node) => {
    if (
      !Node.isFunctionDeclaration(node) &&
      !Node.isMethodDeclaration(node) &&
      !Node.isArrowFunction(node) &&
      !Node.isFunctionExpression(node)
    ) {
      return;
    }
    const fn: FunctionLike = node;

    const predicate = getTypePredicate(fn);
    if (!predicate) return;

    const expr = getReturnExpression(fn);
    if (!expr) return;

    const collapsed = collapseToBuiltinCheck(expr, predicate.paramName);
    if (!collapsed) return;

    const anchor = getNamedFunctionAnchor(fn);
    if (!anchor) return;

    const issue: UselessTypePredicateIssue = {
      kind: "useless-type-predicate",
      location: anchor.location,
      predicateName: anchor.name,
      collapsesTo: collapsed,
      confidence: 0.9,
    };
    out.push(issue);
  });
}

interface TypePredicateInfo {
  paramName: string;
}

function getTypePredicate(fn: FunctionLike): TypePredicateInfo | undefined {
  const returnTypeNode = fn.getReturnTypeNode();
  if (!returnTypeNode || !Node.isTypePredicate(returnTypeNode)) return undefined;
  const paramNode = returnTypeNode.getParameterNameNode();
  if (!paramNode) return undefined;
  const paramText = paramNode.getText();
  if (paramText === "this") return undefined;
  return { paramName: paramText };
}

function getReturnExpression(fn: FunctionLike): Node | undefined {
  const body = fn.getBody();
  if (!body) return undefined;
  if (Node.isBlock(body)) {
    const stmts = body.getStatements();
    if (stmts.length !== 1) return undefined;
    const stmt = stmts[0];
    if (!Node.isReturnStatement(stmt)) return undefined;
    return stmt.getExpression();
  }
  return body;
}

function collapseToBuiltinCheck(expr: Node, paramName: string): string | undefined {
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    if (op === "===" || op === "==" || op === "!==" || op === "!=") {
      const left = expr.getLeft();
      const right = expr.getRight();
      const literal = matchTypeofComparison(left, right, paramName);
      if (literal) return `typeof ${paramName} ${op} ${JSON.stringify(literal)}`;
      const nullish = matchNullishComparison(left, right, paramName);
      if (nullish) return `${paramName} ${op} ${nullish}`;
    }
    if (op === "instanceof") {
      const left = expr.getLeft();
      const right = expr.getRight();
      if (Node.isIdentifier(left) && left.getText() === paramName) {
        return `${paramName} instanceof ${right.getText()}`;
      }
    }
  }

  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      const obj = callee.getExpression();
      const prop = callee.getName();
      if (Node.isIdentifier(obj) && obj.getText() === "Array" && prop === "isArray") {
        const args = expr.getArguments();
        if (args.length === 1 && Node.isIdentifier(args[0]) && args[0].getText() === paramName) {
          return `Array.isArray(${paramName})`;
        }
      }
    }
  }

  return undefined;
}

function matchTypeofComparison(left: Node, right: Node, paramName: string): string | undefined {
  return (
    extractTypeofLiteral(left, right, paramName) ?? extractTypeofLiteral(right, left, paramName)
  );
}

function extractTypeofLiteral(
  typeofSide: Node,
  literalSide: Node,
  paramName: string,
): string | undefined {
  if (!Node.isTypeOfExpression(typeofSide)) return undefined;
  const operand = typeofSide.getExpression();
  if (!Node.isIdentifier(operand) || operand.getText() !== paramName) return undefined;
  if (!Node.isStringLiteral(literalSide)) return undefined;
  const literal = literalSide.getLiteralValue();
  if (!BUILTIN_TYPEOF_LITERALS.has(literal)) return undefined;
  return literal;
}

function matchNullishComparison(left: Node, right: Node, paramName: string): string | undefined {
  for (const [paramSide, otherSide] of [
    [left, right],
    [right, left],
  ] as const) {
    if (!Node.isIdentifier(paramSide) || paramSide.getText() !== paramName) continue;
    if (Node.isNullLiteral(otherSide)) return "null";
    if (Node.isIdentifier(otherSide) && otherSide.getText() === "undefined") return "undefined";
  }
  return undefined;
}

interface TypeFingerprint {
  hash: string;
  fieldCount: number;
}

interface TypeEntry {
  sf: SourceFile;
  name: string;
  location: Location;
  fingerprint: TypeFingerprint;
}

function collectSameShapeTypes(files: SourceFile[], rootDir: string, out: Issue[]): void {
  const entries: TypeEntry[] = [];
  for (const sf of files) {
    for (const decl of sf.getInterfaces()) {
      const entry = entryFromInterface(decl);
      if (entry) entries.push(entry);
    }
    for (const decl of sf.getTypeAliases()) {
      const entry = entryFromTypeAlias(decl);
      if (entry) entries.push(entry);
    }
  }

  const byHash = new Map<string, TypeEntry[]>();
  for (const e of entries) {
    const arr = byHash.get(e.fingerprint.hash) ?? [];
    arr.push(e);
    byHash.set(e.fingerprint.hash, arr);
  }

  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const filtered = excludeVersionedPartners(group);
    if (filtered.length < 2) continue;
    const distinctNames = new Set(filtered.map((g) => g.name));
    if (distinctNames.size < 2) continue;

    const [primary, ...rest] = filtered;
    const issue: SameShapeTypesIssue = {
      kind: "same-shape-types",
      primary: primary.location,
      matches: rest.map((r) => r.location),
      primaryName: primary.name,
      matchNames: rest.map((r) => r.name),
      fieldCount: primary.fingerprint.fieldCount,
      confidence: scoreSameShapeTypes(filtered, rootDir),
    };
    out.push(issue);
  }
}

const VERSION_SUFFIX_RE = /^(.+?)(?:V|_v|Version)\d+$/;

// drop pairs that look like API versions of the same base type (`UserV1`/`UserV2`).
function excludeVersionedPartners(group: TypeEntry[]): TypeEntry[] {
  const baseCounts = new Map<string, number>();
  const baseOf = new Map<TypeEntry, string | undefined>();
  for (const e of group) {
    const m = e.name.match(VERSION_SUFFIX_RE);
    const base = m ? m[1] : undefined;
    baseOf.set(e, base);
    if (base) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  return group.filter((e) => {
    const base = baseOf.get(e);
    return !(base && (baseCounts.get(base) ?? 0) >= 2);
  });
}

function entryFromInterface(decl: InterfaceDeclaration): TypeEntry | undefined {
  const fingerprint = fingerprintFromMembers(decl.getProperties(), decl.getMethods());
  if (!fingerprint) return undefined;
  return entryAround(decl, decl.getName(), fingerprint);
}

function entryFromTypeAlias(decl: TypeAliasDeclaration): TypeEntry | undefined {
  const typeNode = decl.getTypeNode();
  if (!typeNode || !Node.isTypeLiteral(typeNode)) return undefined;
  const literal = typeNode as TypeLiteralNode;
  const fingerprint = fingerprintFromMembers(literal.getProperties(), literal.getMethods());
  if (!fingerprint) return undefined;
  return entryAround(decl, decl.getName(), fingerprint);
}

function entryAround(
  decl: InterfaceDeclaration | TypeAliasDeclaration,
  name: string,
  fingerprint: TypeFingerprint,
): TypeEntry {
  const sf = decl.getSourceFile();
  const nameNode = decl.getNameNode();
  const { line, column } = sf.getLineAndColumnAtPos(nameNode.getStart());
  return { sf, name, location: { file: sf.getFilePath(), line, column }, fingerprint };
}

function fingerprintFromMembers(
  props: PropertySignature[],
  methods: MethodSignature[],
): TypeFingerprint | undefined {
  if (props.length + methods.length < SAME_SHAPE_MIN_FIELDS) return undefined;
  const tuples: string[] = [];
  for (const p of props) {
    const name = p.getName();
    const typeNode = p.getTypeNode();
    const typeText = typeNode ? typeNode.getText().replace(/\s+/g, "") : "any";
    const optional = p.hasQuestionToken() ? "?" : "";
    tuples.push(`prop:${name}${optional}:${typeText}`);
  }
  for (const m of methods) {
    const signature = m.getText().replace(/\s+/g, "");
    tuples.push(`method:${m.getName()}:${signature}`);
  }
  tuples.sort();
  return { hash: tuples.join("|"), fieldCount: tuples.length };
}

function scoreSameShapeTypes(group: TypeEntry[], rootDir: string): number {
  let score = 0.8;

  const inLayer = group.filter((g) =>
    LAYERED_ARCH_RE.test(relative(rootDir, g.location.file).replace(/\\/g, "/")),
  ).length;
  if (inLayer >= 2) score -= 0.2;

  const extraFields = group[0].fingerprint.fieldCount - SAME_SHAPE_MIN_FIELDS;
  score += Math.min(extraFields * 0.025, 0.1);

  return Math.max(0, Math.min(1, score));
}
