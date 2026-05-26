export { scan, scanMonorepo, type ScanResult } from "./core/scanner.js";
export type { ScanOptions } from "./core/config.js";
export type {
  DeadCodeIssue,
  DeadDuplicatePairInsight,
  DeadWrapperChainInsight,
  Detector,
  DetectorContext,
  DetectorName,
  DuplicateIssue,
  EmptyCatchIssue,
  EmptyWrapperIssue,
  Insight,
  Issue,
  Location,
  OrphanedFileInsight,
  OverAbstractionChainInsight,
  SameShapeTypesIssue,
  ScaffoldFolderInsight,
  SymbolKind,
  UnusedExportIssue,
  UselessAsyncIssue,
  UselessTypePredicateIssue,
  WrapperOnlyFileInsight,
} from "./detectors/types.js";
export { toJson, type JsonReport } from "./reporters/json.js";
export { renderResult, renderHeader, renderIssue, type RenderOptions } from "./reporters/terminal.js";
export {
  applyDeadCodeFixes,
  commitDeadCodeFixes,
  type FixPlan,
  type FixResult,
  type PendingFix,
  planDeadCodeFixes,
  prepareDeadCodeFixes,
  type PreparedFixResult,
  rollbackPendingFixes,
} from "./fixers/dead-code.js";
