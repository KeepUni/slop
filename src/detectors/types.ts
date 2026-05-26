import type { Project, SourceFile } from "ts-morph";
import type { ReferencesCache } from "../core/references-cache.js";

export interface Location {
  file: string;
  line: number;
  column: number;
  endLine?: number;
}

export type SymbolKind = "function" | "variable" | "class" | "type" | "enum";

export interface DuplicateIssue {
  kind: "duplicate";
  primary: Location;
  matches: Location[];
  similarity: number;
  preview: string;
  confidence: number;
}

export interface DeadCodeIssue {
  kind: "dead-code";
  location: Location;
  symbol: string;
  symbolKind: SymbolKind;
  exported: boolean;
  confidence: number;
}

export interface UnusedExportIssue {
  kind: "unused-export";
  location: Location;
  symbol: string;
  symbolKind: SymbolKind;
  localUses: number;
  confidence: number;
}

export interface EmptyWrapperIssue {
  kind: "empty-wrapper";
  location: Location;
  outerName: string;
  innerCall: string;
  confidence: number;
}

export interface UselessTypePredicateIssue {
  kind: "useless-type-predicate";
  location: Location;
  predicateName: string;
  collapsesTo: string;
  confidence: number;
}

export interface SameShapeTypesIssue {
  kind: "same-shape-types";
  primary: Location;
  matches: Location[];
  primaryName: string;
  matchNames: string[];
  fieldCount: number;
  confidence: number;
}

export interface UselessAsyncIssue {
  kind: "useless-async";
  location: Location;
  functionName: string;
  confidence: number;
}

export interface EmptyCatchIssue {
  kind: "empty-catch";
  location: Location;
  swallowsAll: boolean;
  rethrowsOnly?: boolean;
  confidence: number;
}

export type Issue =
  | DuplicateIssue
  | DeadCodeIssue
  | UnusedExportIssue
  | EmptyWrapperIssue
  | UselessTypePredicateIssue
  | SameShapeTypesIssue
  | UselessAsyncIssue
  | EmptyCatchIssue;

export interface OrphanedFileInsight {
  kind: "orphaned-file";
  file: string;
  deadSymbols: Array<{ symbol: string; line: number }>;
  confidence: number;
}

export interface DeadWrapperChainInsight {
  kind: "dead-wrapper-chain";
  location: Location;
  outerName: string;
  innerCall: string;
  confidence: number;
}

export interface DeadDuplicatePairInsight {
  kind: "dead-duplicate-pair";
  primary: Location;
  matches: Location[];
  primarySymbol: string;
  matchSymbols: string[];
  similarity: number;
  confidence: number;
}

export interface WrapperOnlyFileInsight {
  kind: "wrapper-only-file";
  file: string;
  wrapperCount: number;
  totalExports: number;
  confidence: number;
}

export interface OverAbstractionChainInsight {
  kind: "over-abstraction-chain";
  chain: Array<{ location: Location; name: string }>;
  terminalCall: string;
  confidence: number;
}

export interface ScaffoldFolderInsight {
  kind: "scaffold-folder";
  folder: string;
  files: string[];
  scaffold: "shadcn-ui";
  confidence: number;
}

export type Insight =
  | OrphanedFileInsight
  | DeadWrapperChainInsight
  | DeadDuplicatePairInsight
  | WrapperOnlyFileInsight
  | OverAbstractionChainInsight
  | ScaffoldFolderInsight;

export type DetectorName =
  | "duplicates"
  | "dead-code"
  | "empty-wrappers"
  | "ai-signatures"
  | "code-smells";

export interface DetectorContext {
  project: Project;
  files: SourceFile[];
  rootDir: string;
  refs: ReferencesCache;
  externallyConsumed?: ReadonlySet<string>;
}

export interface Detector {
  name: DetectorName;
  run(ctx: DetectorContext): Promise<Issue[]>;
}
