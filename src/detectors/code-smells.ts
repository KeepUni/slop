import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { isGeneratedFilePath, isGeneratedSource, isTestFilePath } from "../core/config.js";
import {
  getNamedFunctionAnchor,
  isInsideApiObject,
  isTypedVariableAlias,
  lastReturnMatches,
  methodHasOverrideContext,
} from "../utils/ast.js";
import { isFrameworkConventionFunction } from "../utils/framework.js";
import type {
  Detector,
  DetectorContext,
  EmptyCatchIssue,
  Issue,
  UselessAsyncIssue,
} from "./types.js";

type FunctionLike = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

export const codeSmellsDetector: Detector = {
  name: "code-smells",
  async run(ctx: DetectorContext): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const sf of ctx.files) {
      const filePath = sf.getFilePath();
      if (isTestFilePath(filePath, ctx.rootDir)) continue;
      if (isGeneratedFilePath(filePath)) continue;
      if (isGeneratedSource(sf.getFullText())) continue;
      collectUselessAsync(sf, ctx.rootDir, out);
      collectEmptyCatch(sf, out);
    }
    return out;
  },
};

const PUBLICATION_DIR_RE =
  /[\\/](?:registry|styles|themes|variants|templates?|examples|presets|demos|icons|assets)[\\/]/i;

const MIGRATIONS_PATH_RE = /[\\/]migrations?[\\/]/i;

function collectUselessAsync(sf: SourceFile, rootDir: string, out: Issue[]): void {
  const filePath = sf.getFilePath();
  if (PUBLICATION_DIR_RE.test(filePath)) return;
  if (MIGRATIONS_PATH_RE.test(filePath)) return;
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
    if (!fn.isAsync()) return;
    if (containsAwaitOrForAwait(fn)) return;
    if (returnsPromiseDirectly(fn)) return;
    if (hasExplicitPromiseReturnType(fn)) return;
    if (isFrameworkConventionFunction(fn, rootDir)) return;
    if (returnsBareCall(fn)) return;
    if (isTypedVariableAlias(fn)) return;
    if (isInsideApiObject(fn)) return;
    if (isIntentionalAsyncStub(fn)) return;
    if (returnsJsxElement(fn)) return;

    const anchor = getNamedFunctionAnchor(fn);
    if (!anchor) return;
    if (Node.isMethodDeclaration(fn) && methodHasOverrideContext(fn)) return;

    const issue: UselessAsyncIssue = {
      kind: "useless-async",
      location: anchor.location,
      functionName: anchor.name,
      confidence: 0.8,
    };
    out.push(issue);
  });
}

function returnsJsxElement(fn: FunctionLike): boolean {
  return lastReturnMatches(fn, isJsxLike);
}

function isPureRethrow(stmt: Node, paramName: string | undefined): boolean {
  if (!paramName) return false;
  if (!Node.isThrowStatement(stmt)) return false;
  const expr = stmt.getExpression();
  return Node.isIdentifier(expr) && expr.getText() === paramName;
}

function blockHasComment(block: Node): boolean {
  const text = block.getText();
  if (text.length <= 2) return false;
  const inner = text.slice(1, -1);
  return /\/\/|\/\*/.test(inner);
}

function lineHasTrailingComment(node: Node, sf: SourceFile): boolean {
  const end = node.getEnd();
  const full = sf.getFullText();
  let i = end;
  while (i < full.length && full[i] !== "\n") {
    if (full[i] === "/" && (full[i + 1] === "/" || full[i + 1] === "*")) return true;
    i++;
  }
  return false;
}

function isJsxLike(node: Node): boolean {
  if (Node.isParenthesizedExpression(node)) {
    const inner = node.getExpression();
    return inner !== undefined && isJsxLike(inner);
  }
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

function isIntentionalAsyncStub(fn: FunctionLike): boolean {
  const body = fn.getBody();
  if (!body || !Node.isBlock(body) || body.getStatements().length > 0) return false;
  for (const p of fn.getParameters()) {
    const nameNode = p.getNameNode();
    if (Node.isIdentifier(nameNode) && nameNode.getText().startsWith("_")) return true;
  }
  return false;
}

function returnsBareCall(fn: FunctionLike): boolean {
  return lastReturnMatches(fn, Node.isCallExpression);
}

function containsAwaitOrForAwait(fn: FunctionLike): boolean {
  const body = fn.getBody();
  if (!body) return true;
  let found = false;
  body.forEachDescendant((node, traversal) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      traversal.skip();
      return;
    }
    if (Node.isAwaitExpression(node)) {
      found = true;
      traversal.stop();
      return;
    }
    if (Node.isForOfStatement(node) && node.isAwaited()) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

function hasExplicitPromiseReturnType(fn: FunctionLike): boolean {
  const typeNode = fn.getReturnTypeNode?.();
  if (!typeNode) return false;
  const text = typeNode.getText();
  return /\bPromise\b/.test(text);
}

function returnsPromiseDirectly(fn: FunctionLike): boolean {
  const body = fn.getBody();
  if (!body) return false;
  if (!Node.isBlock(body)) {
    return looksLikePromise(body);
  }
  const stmts = body.getStatements();
  for (const stmt of stmts) {
    if (Node.isReturnStatement(stmt)) {
      const expr = stmt.getExpression();
      if (expr && looksLikePromise(expr)) return true;
    }
  }
  return false;
}

function looksLikePromise(node: Node): boolean {
  if (Node.isNewExpression(node)) {
    const ident = node.getExpression();
    if (Node.isIdentifier(ident) && ident.getText() === "Promise") return true;
  }
  if (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      const obj = callee.getExpression();
      if (Node.isIdentifier(obj) && obj.getText() === "Promise") return true;
    }
  }
  return false;
}

function collectEmptyCatch(sf: SourceFile, out: Issue[]): void {
  if (PUBLICATION_DIR_RE.test(sf.getFilePath())) return;
  for (const clause of sf.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const block = clause.getBlock();
    const stmts = block.getStatements();
    const param = clause.getVariableDeclaration();
    const paramName = param?.getName();
    if (paramName && paramName.startsWith("_")) continue;

    const empty = stmts.length === 0;
    const rethrow = stmts.length === 1 && isPureRethrow(stmts[0], paramName);
    if (!empty && !rethrow) continue;
    if (empty && (blockHasComment(block) || lineHasTrailingComment(clause, sf))) continue;

    const swallowsAll = empty && param === undefined;
    const { line, column } = sf.getLineAndColumnAtPos(clause.getStart());
    const issue: EmptyCatchIssue = {
      kind: "empty-catch",
      location: { file: sf.getFilePath(), line, column },
      swallowsAll,
      ...(rethrow && { rethrowsOnly: true }),
      confidence: rethrow ? 0.8 : swallowsAll ? 0.85 : 0.75,
    };
    out.push(issue);
  }
}
