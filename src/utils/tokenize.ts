import { ts } from "ts-morph";

export interface Token {
  kind: ts.SyntaxKind;
  normalized: string;
  text: string;
  line: number;
  pos: number;
}

const SKIP_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
  ts.SyntaxKind.ConflictMarkerTrivia,
]);

const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

export function tokenize(source: string, scriptKind: ts.ScriptKind = ts.ScriptKind.TSX): Token[] {
  const skipRanges = computeImportSkipRanges(source, scriptKind);

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    languageVariant(scriptKind),
    source,
  );

  // ts.createScanner doesn't re-enter template mode after `${...}`. Track
  // brace depth per template level and call reScanTemplateToken when a `}`
  // closes the substitution itself.
  const braceStack: number[] = [];

  const tokens: Token[] = [];
  let token = scanner.scan();
  let rangeIdx = 0;
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.TemplateHead) {
      braceStack.push(0);
    } else if (token === ts.SyntaxKind.TemplateMiddle) {
      if (braceStack.length > 0) braceStack[braceStack.length - 1] = 0;
    } else if (token === ts.SyntaxKind.TemplateTail) {
      braceStack.pop();
    } else if (braceStack.length > 0) {
      const top = braceStack.length - 1;
      if (token === ts.SyntaxKind.OpenBraceToken) {
        braceStack[top]++;
      } else if (token === ts.SyntaxKind.CloseBraceToken) {
        if (braceStack[top] > 0) {
          braceStack[top]--;
        } else {
          token = scanner.reScanTemplateToken(false);
          if (token === ts.SyntaxKind.TemplateTail) braceStack.pop();
        }
      }
    }

    if (!SKIP_KINDS.has(token)) {
      const pos = scanner.getTokenStart();

      while (rangeIdx < skipRanges.length && skipRanges[rangeIdx][1] <= pos) rangeIdx++;
      const inSkip =
        rangeIdx < skipRanges.length &&
        pos >= skipRanges[rangeIdx][0] &&
        pos < skipRanges[rangeIdx][1];

      if (!inSkip) {
        const text = scanner.getTokenText();
        tokens.push({
          kind: token,
          normalized: normalize(token, text),
          text,
          line: lineOf(source, pos),
          pos,
        });
      }
    }
    token = scanner.scan();
  }
  return tokens;
}

function computeImportSkipRanges(
  source: string,
  scriptKind: ts.ScriptKind,
): Array<[number, number]> {
  const sf = ts.createSourceFile(
    "__tokenize__.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  const ranges: Array<[number, number]> = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      ranges.push([stmt.getStart(sf), stmt.getEnd()]);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      ranges.push([stmt.getStart(sf), stmt.getEnd()]);
    }
  }
  return ranges;
}

function languageVariant(scriptKind: ts.ScriptKind): ts.LanguageVariant {
  return scriptKind === ts.ScriptKind.TSX || scriptKind === ts.ScriptKind.JSX
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard;
}

function normalize(kind: ts.SyntaxKind, text: string): string {
  if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) return "$ID";
  if (LITERAL_KINDS.has(kind)) return "$LIT";
  return text;
}

function lineOf(source: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function scriptKindFromPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  if (path.endsWith(".mjs") || path.endsWith(".cjs") || path.endsWith(".js"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TSX;
}
