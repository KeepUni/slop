import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from "ts-morph";
import { isGeneratedFilePath, isGeneratedSource, isTestFilePath } from "../core/config.js";
import {
  hasDeprecatedJsDoc,
  isInsideApiObject,
  isLiteralExpression,
  isTypedVariableAlias,
  methodHasOverrideContext,
} from "../utils/ast.js";
import { isFrameworkConventionFunction } from "../utils/framework.js";
import type { Detector, DetectorContext, EmptyWrapperIssue } from "./types.js";

type FunctionLike = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

const HOOK_NAMES = new Set(["useCallback", "useMemo", "useEffect", "useLayoutEffect"]);

const PUBLICATION_DIR_RE =
  /[\\/](?:registry|styles|themes|variants|templates?|examples|presets|demos|icons|assets)[\\/]/i;

export const emptyWrappersDetector: Detector = {
  name: "empty-wrappers",
  async run(ctx: DetectorContext): Promise<EmptyWrapperIssue[]> {
    const issues: EmptyWrapperIssue[] = [];
    for (const sf of ctx.files) {
      const filePath = sf.getFilePath();
      if (isTestFilePath(filePath, ctx.rootDir)) continue;
      if (PUBLICATION_DIR_RE.test(filePath)) continue;
      if (isGeneratedFilePath(filePath)) continue;
      if (isGeneratedSource(sf.getFullText())) continue;
      collectFromFile(sf, ctx.rootDir, issues);
    }
    return issues;
  },
};

function collectFromFile(sf: SourceFile, rootDir: string, out: EmptyWrapperIssue[]): void {
  sf.forEachDescendant((node) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      const issue = analyzeFunction(node, rootDir);
      if (issue) out.push(issue);
    }
  });
}

function analyzeFunction(fn: FunctionLike, rootDir: string): EmptyWrapperIssue | undefined {
  if (isInsideHook(fn)) return undefined;
  if (Node.isMethodDeclaration(fn) && methodHasOverrideContext(fn)) return undefined;
  if (hasDecorators(fn)) return undefined;
  if (isFrameworkConventionFunction(fn, rootDir)) return undefined;
  if (returnsTypePredicate(fn)) return undefined;
  if (hasGenericTypeParameters(fn)) return undefined;
  if (isTypedVariableAlias(fn)) return undefined;
  if (isInsideApiObject(fn)) return undefined;
  if (hasDeprecatedJsDoc(fn)) return undefined;

  const outerName = getFunctionName(fn);
  if (!outerName) return undefined;

  const jsxRender = extractJsxPassThrough(fn);
  if (jsxRender) {
    return buildIssue(fn, outerName, jsxRender, scoreEmptyWrapper(fn, outerName) - 0.05);
  }

  const passThrough = extractPassThroughCall(fn);
  if (!passThrough) return undefined;

  if (calleeIsMethodOnLiteral(passThrough)) return undefined;
  if (calleeChainHasInnerCall(passThrough)) return undefined;
  if (calleeIsPredicateOverRegex(passThrough)) return undefined;
  if (calleeChainRootedAtThis(passThrough)) return undefined;

  const calleeName = getCalleeRootName(passThrough);
  if (!calleeName) return undefined;
  if (calleeName === outerName) return undefined;
  if (calleeName.startsWith("_") && !outerName.startsWith("_")) return undefined;

  const params = getParamNames(fn);
  if (params.length === 0) return undefined;
  if (!argsMatchParams(passThrough, params)) return undefined;

  return buildIssue(fn, outerName, renderCall(passThrough), scoreEmptyWrapper(fn, outerName));
}

function buildIssue(
  fn: FunctionLike,
  outerName: string,
  innerCall: string,
  confidence: number,
): EmptyWrapperIssue {
  const sf = fn.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(getNameAnchor(fn));
  return {
    kind: "empty-wrapper",
    location: { file: sf.getFilePath(), line, column },
    outerName,
    innerCall,
    confidence,
  };
}

function extractJsxPassThrough(fn: FunctionLike): string | undefined {
  const params = fn.getParameters();
  if (params.length !== 1) return undefined;
  const param = params[0];
  if (param.hasInitializer() || param.isRestParameter()) return undefined;

  const paramName = resolveJsxSpreadParamName(param);
  if (!paramName) return undefined;

  const jsx = extractReturnedJsxElement(fn);
  if (!jsx) return undefined;
  return jsxSpreadsExactlyParam(jsx, paramName);
}

function resolveJsxSpreadParamName(param: import("ts-morph").ParameterDeclaration): string | undefined {
  const nameNode = param.getNameNode();
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  if (Node.isObjectBindingPattern(nameNode)) {
    const elements = nameNode.getElements();
    if (elements.length !== 1) return undefined;
    const elem = elements[0];
    if (!elem.getDotDotDotToken()) return undefined;
    const inner = elem.getNameNode();
    if (Node.isIdentifier(inner)) return inner.getText();
  }
  return undefined;
}

function extractReturnedJsxElement(fn: FunctionLike): Node | undefined {
  const body = fn.getBody();
  if (!body) return undefined;
  if (!Node.isBlock(body)) {
    if (Node.isParenthesizedExpression(body)) {
      const inner = body.getExpression();
      return Node.isJsxElement(inner) || Node.isJsxSelfClosingElement(inner) ? inner : undefined;
    }
    return Node.isJsxElement(body) || Node.isJsxSelfClosingElement(body) ? body : undefined;
  }
  const stmts = body.getStatements();
  if (stmts.length !== 1) return undefined;
  const stmt = stmts[0];
  if (!Node.isReturnStatement(stmt)) return undefined;
  let expr = stmt.getExpression();
  if (!expr) return undefined;
  while (Node.isParenthesizedExpression(expr)) {
    const next = expr.getExpression();
    if (!next) return undefined;
    expr = next;
  }
  return Node.isJsxElement(expr) || Node.isJsxSelfClosingElement(expr) ? expr : undefined;
}

function jsxSpreadsExactlyParam(jsx: Node, paramName: string): string | undefined {
  const opening = Node.isJsxElement(jsx) ? jsx.getOpeningElement() : jsx;
  if (!Node.isJsxSelfClosingElement(opening) && !Node.isJsxOpeningElement(opening)) return undefined;
  const tagName = opening.getTagNameNode().getText();
  const attr = onlyElement(opening.getAttributes());
  if (!attr || !Node.isJsxSpreadAttribute(attr)) return undefined;
  const expr = attr.getExpression();
  if (!Node.isIdentifier(expr) || expr.getText() !== paramName) return undefined;
  if (Node.isJsxElement(jsx)) {
    const children = jsx.getJsxChildren();
    if (children.some((c) => !isWhitespaceOnly(c))) return undefined;
  }
  return `<${tagName} {...${paramName}} />`;
}

function isWhitespaceOnly(node: Node): boolean {
  if (Node.isJsxText(node)) return node.getText().trim() === "";
  return false;
}

function scoreEmptyWrapper(fn: FunctionLike, outerName: string): number {
  let score = 0.85;

  const isAsync =
    (Node.isFunctionDeclaration(fn) ||
      Node.isMethodDeclaration(fn) ||
      Node.isArrowFunction(fn) ||
      Node.isFunctionExpression(fn)) &&
    fn.isAsync();
  if (isAsync) score -= 0.1;

  if (hasJsDoc(fn)) score -= 0.15;
  if (outerName.length <= 3) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

function hasJsDoc(fn: FunctionLike): boolean {
  const maybe = fn as unknown as { getJsDocs?: () => unknown[] };
  if (typeof maybe.getJsDocs !== "function") return false;
  return maybe.getJsDocs().length > 0;
}

function extractPassThroughCall(fn: FunctionLike): CallExpression | undefined {
  const body = fn.getBody();
  if (!body) return undefined;
  if (!Node.isBlock(body)) return asCallOrAwaited(body);
  const stmts = body.getStatements();
  if (stmts.length === 1) return singleReturnCall(stmts[0]);
  if (stmts.length === 2) return varThenReturnCall(stmts[0], stmts[1]);
  return undefined;
}

function singleReturnCall(stmt: Statement): CallExpression | undefined {
  if (!Node.isReturnStatement(stmt)) return undefined;
  const expr = stmt.getExpression();
  return expr ? asCallOrAwaited(expr) : undefined;
}

// `const x = bar(args); return x;` — same shape as `return bar(args)` after
// flattening; the intermediate variable adds no semantics.
function varThenReturnCall(first: Statement, second: Statement): CallExpression | undefined {
  if (!Node.isVariableStatement(first) || !Node.isReturnStatement(second)) return undefined;
  const [decl] = first.getDeclarations();
  if (!decl) return undefined;
  const nameNode = decl.getNameNode();
  const init = decl.getInitializer();
  if (!Node.isIdentifier(nameNode) || !init) return undefined;
  const call = asCallOrAwaited(init);
  const ret = second.getExpression();
  if (!call || !ret || !Node.isIdentifier(ret) || ret.getText() !== nameNode.getText()) {
    return undefined;
  }
  return call;
}

function onlyElement<T>(arr: readonly T[]): T | undefined {
  return arr.length === 1 ? arr[0] : undefined;
}

function asCallOrAwaited(node: Node): CallExpression | undefined {
  if (Node.isCallExpression(node)) return node;
  if (Node.isAwaitExpression(node)) {
    const inner = node.getExpression();
    return inner ? asCallOrAwaited(inner) : undefined;
  }
  if (Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
    return asCallOrAwaited(node.getExpression());
  }
  return undefined;
}

function getNameAnchor(fn: FunctionLike): number {
  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn) ||
    Node.isFunctionExpression(fn)
  ) {
    return (fn.getNameNode() ?? fn).getStart();
  }
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getNameNode().getStart();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getNameNode().getStart();
  return fn.getStart();
}

function getFunctionName(fn: FunctionLike): string | undefined {
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) {
    const parent = fn.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      const nameNode = parent.getNameNode();
      return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
    }
    if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
    return undefined;
  }
  return fn.getName();
}

function getCalleeRootName(call: CallExpression): string | undefined {
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  return undefined;
}

function calleeIsMethodOnLiteral(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  return isLiteralExpression(callee.getExpression());
}

function calleeIsPredicateOverRegex(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (callee.getName() !== "test") return false;
  return Node.isIdentifier(callee.getExpression());
}

function calleeChainRootedAtThis(call: CallExpression): boolean {
  let cursor: Node | undefined = call.getExpression();
  while (cursor) {
    if (Node.isPropertyAccessExpression(cursor)) {
      cursor = cursor.getExpression();
      continue;
    }
    return cursor !== undefined && cursor.getKind() === SyntaxKind.ThisKeyword;
  }
  return false;
}

function calleeChainHasInnerCall(call: CallExpression): boolean {
  let cursor: Node | undefined = call.getExpression();
  while (cursor) {
    if (Node.isPropertyAccessExpression(cursor)) {
      const left = cursor.getExpression();
      if (Node.isCallExpression(left) || Node.isNewExpression(left)) return true;
      cursor = left;
    } else {
      return false;
    }
  }
  return false;
}

function hasGenericTypeParameters(fn: FunctionLike): boolean {
  const params = fn.getTypeParameters?.();
  return Array.isArray(params) && params.length > 0;
}

function returnsTypePredicate(fn: FunctionLike): boolean {
  const returnTypeNode = fn.getReturnTypeNode?.();
  return returnTypeNode !== undefined && Node.isTypePredicate(returnTypeNode);
}

function getParamNames(fn: FunctionLike): Array<string | null> {
  return fn.getParameters().map((p) => {
    if (p.hasInitializer() || p.isRestParameter()) return null;
    const nameNode = p.getNameNode();
    return Node.isIdentifier(nameNode) ? nameNode.getText() : null;
  });
}

function argsMatchParams(call: CallExpression, params: Array<string | null>): boolean {
  const args = call.getArguments();
  if (args.length !== params.length) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const param = params[i];
    if (param === null) return false;
    if (!Node.isIdentifier(arg)) return false;
    if (arg.getText() !== param) return false;
  }
  return true;
}

function hasDecorators(fn: FunctionLike): boolean {
  if (!Node.isMethodDeclaration(fn)) return false;
  const decorators = fn.getDecorators?.();
  return Array.isArray(decorators) && decorators.length > 0;
}

function isInsideHook(fn: FunctionLike): boolean {
  const parent = fn.getParent();
  if (!parent || !Node.isCallExpression(parent)) return false;
  const callee = parent.getExpression();
  if (Node.isIdentifier(callee) && HOOK_NAMES.has(callee.getText())) return true;
  if (Node.isPropertyAccessExpression(callee) && HOOK_NAMES.has(callee.getName())) return true;
  return false;
}

function renderCall(call: CallExpression): string {
  const callee = call.getExpression().getText();
  const args = call
    .getArguments()
    .map((a) => a.getText())
    .join(", ");
  return `${callee}(${args})`;
}
