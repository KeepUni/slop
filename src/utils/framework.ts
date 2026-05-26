import { relative } from "node:path";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
} from "ts-morph";

type FunctionLike = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

const NEXTJS_ROUTE_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "HEAD",
]);

const NEXTJS_APP_NAMED_EXPORTS = new Set([
  "generateStaticParams",
  "generateMetadata",
  "generateViewport",
  "generateImageMetadata",
]);

const NEXTJS_PAGES_NAMED_EXPORTS = new Set([
  "getStaticProps",
  "getStaticPaths",
  "getServerSideProps",
  "getInitialProps",
]);

const NEXTJS_ROUTE_FILE = /(^|\/)app\/(.+\/)?route\.(ts|tsx|js|jsx)$/;

const NEXTJS_APP_CONVENTION_FILE =
  /(^|\/)app\/(.+\/)?(route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest|head|page|layout|loading|error|template|default|not-found|global-error)\.(ts|tsx|js|jsx)$/;

const NEXTJS_PAGES_FILE = /(^|\/)pages\/(.+)\.(ts|tsx|js|jsx)$/;

const NEXTJS_PAGES_API = /(^|\/)pages\/api\/.+\.(ts|tsx|js|jsx)$/;

const NEXTJS_TOP_LEVEL_CONVENTION =
  /(^|\/)(middleware|instrumentation|instrumentation-client)\.(ts|js|mjs|cjs)$/;

export function isFrameworkConventionFunction(fn: FunctionLike, rootDir: string): boolean {
  const sf = fn.getSourceFile();
  const rel = relative(rootDir, sf.getFilePath()).replace(/\\/g, "/");
  const named = namedExportContext(fn);

  if (Node.isFunctionDeclaration(fn)) {
    const name = fn.getName();
    if (NEXTJS_ROUTE_FILE.test(rel)) {
      if (name && NEXTJS_ROUTE_HTTP_METHODS.has(name) && fn.isExported()) return true;
    }
    if (NEXTJS_APP_CONVENTION_FILE.test(rel)) {
      if (fn.isDefaultExport()) return true;
      if (name && NEXTJS_APP_NAMED_EXPORTS.has(name) && fn.isExported()) return true;
    }
    if (NEXTJS_PAGES_FILE.test(rel)) {
      if (name && NEXTJS_PAGES_NAMED_EXPORTS.has(name) && fn.isExported()) return true;
    }
    if (NEXTJS_PAGES_API.test(rel) && fn.isDefaultExport()) return true;
    if (NEXTJS_TOP_LEVEL_CONVENTION.test(rel) && fn.isDefaultExport()) return true;
    if (fileHasUseServerDirective(sf) && fn.isExported()) return true;
    return false;
  }

  if (!named) return false;
  if (NEXTJS_ROUTE_FILE.test(rel) && NEXTJS_ROUTE_HTTP_METHODS.has(named.name)) return true;
  if (NEXTJS_APP_CONVENTION_FILE.test(rel) && NEXTJS_APP_NAMED_EXPORTS.has(named.name)) return true;
  if (NEXTJS_PAGES_FILE.test(rel) && NEXTJS_PAGES_NAMED_EXPORTS.has(named.name)) return true;
  if (fileHasUseServerDirective(sf)) return true;
  return false;
}

function namedExportContext(fn: FunctionLike): { name: string } | undefined {
  if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return undefined;
  const parent = fn.getParent();
  if (!parent || !Node.isVariableDeclaration(parent)) return undefined;
  const nameNode = parent.getNameNode();
  if (!Node.isIdentifier(nameNode)) return undefined;
  const stmt = parent.getVariableStatement();
  if (!stmt || !stmt.isExported()) return undefined;
  return { name: nameNode.getText() };
}

function fileHasUseServerDirective(sf: SourceFile): boolean {
  const stmts = sf.getStatements();
  for (const stmt of stmts) {
    if (!Node.isExpressionStatement(stmt)) return false;
    const expr = stmt.getExpression();
    if (!Node.isStringLiteral(expr) && !Node.isNoSubstitutionTemplateLiteral(expr)) return false;
    const text = expr.getLiteralValue();
    if (text === "use server") return true;
    if (text === "use client") return false;
  }
  return false;
}
