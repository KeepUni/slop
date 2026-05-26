import {
  type ArrowFunction,
  type ExportDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type ImportDeclaration,
  type MethodDeclaration,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { Location } from "../detectors/types.js";

type NamedFunction = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

const FUNCTION_LIKE_PREDICATES: ReadonlyArray<(n: Node) => boolean> = [
  Node.isFunctionDeclaration,
  Node.isMethodDeclaration,
  Node.isArrowFunction,
  Node.isFunctionExpression,
  Node.isConstructorDeclaration,
  Node.isGetAccessorDeclaration,
  Node.isSetAccessorDeclaration,
];

const LITERAL_EXPRESSION_PREDICATES: ReadonlyArray<(n: Node) => boolean> = [
  Node.isRegularExpressionLiteral,
  Node.isArrayLiteralExpression,
  Node.isObjectLiteralExpression,
  Node.isStringLiteral,
  Node.isNoSubstitutionTemplateLiteral,
  Node.isTemplateExpression,
  Node.isNumericLiteral,
];

export function isFunctionLike(node: Node): boolean {
  return matchesAny(node, FUNCTION_LIKE_PREDICATES);
}

export function isLiteralExpression(node: Node): boolean {
  return matchesAny(node, LITERAL_EXPRESSION_PREDICATES);
}

function matchesAny(node: Node, predicates: ReadonlyArray<(n: Node) => boolean>): boolean {
  for (const p of predicates) if (p(node)) return true;
  return false;
}

export function methodHasOverrideContext(method: MethodDeclaration): boolean {
  if (method.hasOverrideKeyword?.()) return true;
  const cls = method.getParent();
  if (!cls || (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls))) return false;
  if (cls.getExtends()) return true;
  if (cls.getImplements().length > 0) return true;
  return false;
}

export function safeGetSpecifierSourceFile(
  decl: ImportDeclaration | ExportDeclaration,
): SourceFile | undefined {
  try {
    return decl.getModuleSpecifierSourceFile();
  } catch {
    return undefined;
  }
}

export function safeGetSpecifierValue(
  decl: ImportDeclaration | ExportDeclaration,
): string | undefined {
  try {
    return decl.getModuleSpecifierValue();
  } catch {
    return undefined;
  }
}

export function isTypedVariableAlias(fn: NamedFunction): boolean {
  if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return false;
  const parent = fn.getParent();
  if (!parent || !Node.isVariableDeclaration(parent)) return false;
  return parent.getTypeNode() !== undefined;
}

export function isInsideApiObject(fn: NamedFunction): boolean {
  let obj = enclosingObjectLiteral(fn);
  while (obj) {
    if (isApiSurfaceObject(obj)) return true;
    const owner = obj.getParent();
    if (!owner || !Node.isPropertyAssignment(owner)) return false;
    const grand = owner.getParent();
    if (!grand || !Node.isObjectLiteralExpression(grand)) return false;
    obj = grand;
  }
  return false;
}

function enclosingObjectLiteral(fn: NamedFunction): ObjectLiteralExpression | undefined {
  const parent = fn.getParent();
  if (!parent) return undefined;
  if (Node.isMethodDeclaration(fn) && Node.isObjectLiteralExpression(parent)) return parent;
  if (Node.isPropertyAssignment(parent)) {
    const grand = parent.getParent();
    if (grand && Node.isObjectLiteralExpression(grand)) return grand;
  }
  return undefined;
}

function isApiSurfaceObject(obj: ObjectLiteralExpression): boolean {
  let inner: Node = obj;
  let owner: Node | undefined = obj.getParent();
  while (
    owner &&
    (Node.isAsExpression(owner) ||
      Node.isTypeAssertion(owner) ||
      Node.isSatisfiesExpression(owner) ||
      Node.isParenthesizedExpression(owner) ||
      Node.isNonNullExpression(owner))
  ) {
    inner = owner;
    owner = owner.getParent();
  }
  if (!owner) return false;
  if (Node.isReturnStatement(owner)) return true;
  if (Node.isArrowFunction(owner)) return true;
  if (Node.isVariableDeclaration(owner)) {
    return owner.getTypeNode() !== undefined && owner.getInitializer() === inner;
  }
  if (Node.isCallExpression(owner) || Node.isNewExpression(owner)) {
    return owner.getArguments().includes(inner);
  }
  if (Node.isBinaryExpression(owner)) {
    return owner.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
  }
  return false;
}

export function hasDeprecatedJsDoc(fn: NamedFunction): boolean {
  const maybe = fn as unknown as { getJsDocs?: () => Array<{ getTags: () => Array<{ getTagName: () => string }> }> };
  if (typeof maybe.getJsDocs !== "function") return false;
  for (const doc of maybe.getJsDocs()) {
    for (const tag of doc.getTags()) {
      if (tag.getTagName() === "deprecated") return true;
    }
  }
  return false;
}

export function lastReturnMatches(fn: NamedFunction, predicate: (node: Node) => boolean): boolean {
  const body = fn.getBody();
  if (!body) return false;
  if (!Node.isBlock(body)) return predicate(body);
  const stmts = body.getStatements();
  if (stmts.length === 0) return false;
  const last = stmts[stmts.length - 1];
  if (!Node.isReturnStatement(last)) return false;
  const expr = last.getExpression();
  return expr !== undefined && predicate(expr);
}

export function getNamedFunctionAnchor(
  fn: NamedFunction,
): { name: string; location: Location } | undefined {
  const sf: SourceFile = fn.getSourceFile();
  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn) ||
    Node.isFunctionExpression(fn)
  ) {
    const nameNode = fn.getNameNode();
    if (!nameNode) return undefined;
    const { line, column } = sf.getLineAndColumnAtPos(nameNode.getStart());
    return { name: nameNode.getText(), location: { file: sf.getFilePath(), line, column } };
  }
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    const nameNode = parent.getNameNode();
    if (!Node.isIdentifier(nameNode)) return undefined;
    const { line, column } = sf.getLineAndColumnAtPos(nameNode.getStart());
    return { name: nameNode.getText(), location: { file: sf.getFilePath(), line, column } };
  }
  if (parent && Node.isPropertyAssignment(parent)) {
    const nameNode = parent.getNameNode();
    const { line, column } = sf.getLineAndColumnAtPos(nameNode.getStart());
    return { name: parent.getName(), location: { file: sf.getFilePath(), line, column } };
  }
  return undefined;
}
