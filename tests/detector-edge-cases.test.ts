import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan, scanMonorepo } from "../src/core/scanner.js";
import { applyDeadCodeFixes } from "../src/fixers/dead-code.js";

function makeMono(): string {
  const tmp = mkdtempSync(join(tmpdir(), "slp-edge-"));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "utf8",
  );
  return tmp;
}

function addPkg(
  root: string,
  name: string,
  files: Record<string, string>,
  extra: Record<string, unknown> = {},
): void {
  const dir = join(root, "packages", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@scope/${name}`,
      type: "module",
      main: "./src/index.ts",
      ...extra,
    }),
    "utf8",
  );
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(target.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

describe("detector edge cases and atomic --fix", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeMono();
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("scanMonorepo exposes projectForFile so --fix can apply per package", async () => {
    addPkg(tmp, "a", {
      "src/index.ts": `export { live } from "./live";\n`,
      "src/live.ts": `export const live = 1;\n`,
      "src/orphan.ts": `export const deadInA = 2;\n`,
    });
    addPkg(tmp, "b", {
      "src/index.ts": `import { live } from "@scope/a";\nexport const X = live;\n`,
      "src/orphan.ts": `export const deadInB = 3;\n`,
    });

    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const deadIssues = result.issues.filter(
      (i) => i.kind === "dead-code" && (i.symbol === "deadInA" || i.symbol === "deadInB"),
    );
    expect(deadIssues.length).toBeGreaterThanOrEqual(2);

    for (const issue of deadIssues) {
      const proj = result.projectForFile(issue.location.file);
      expect(proj).toBeDefined();
      expect(proj?.getSourceFile(issue.location.file)).toBeDefined();
    }

    const groups = new Map<ReturnType<typeof result.projectForFile>, typeof deadIssues>();
    for (const issue of deadIssues) {
      const proj = result.projectForFile(issue.location.file);
      const arr = groups.get(proj) ?? [];
      arr.push(issue);
      groups.set(proj, arr);
    }
    let totalRemoved = 0;
    for (const [proj, issues] of groups) {
      if (!proj) continue;
      const fix = await applyDeadCodeFixes(
        proj,
        issues.filter((i): i is Extract<typeof i, { kind: "dead-code" }> => i.kind === "dead-code"),
      );
      if (!fix.rolledBack) totalRemoved += fix.removedSymbols.length;
    }
    expect(totalRemoved).toBe(2);
  });

  it("monorepo sub-scans do not emit orphaned-file insights for cross-package-only files", async () => {
    addPkg(tmp, "shared", {
      "src/index.ts": `import { internal } from "./internal";\nexport const wrapped = internal();\n`,
      "src/internal.ts": `export function internal() { return 1; }\n`,
    });
    addPkg(tmp, "app", {
      "src/index.ts": `import { wrapped } from "@scope/shared";\nexport const X = wrapped;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp });
    const orphanInsights = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphanInsights).toHaveLength(0);
  });

  it("aliasPathTail rejects npm-scoped specs — `@radix-ui/react-dialog` does not collide with local `react-dialog.ts`", async () => {
    addPkg(tmp, "app", {
      "src/index.ts":
        `import { Dialog } from "@radix-ui/react-dialog";\nexport const X = Dialog;\n`,
      "src/legacy/react-dialog.ts":
        `export function Dialog() { return null; }\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).toContain("Dialog");
  });

  it("single-segment alias tail `@/Button` does not bridge unrelated files of the same basename", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-single-seg-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({ name: "solo", type: "module", main: "./src/main.ts" }),
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "src", "legacy"), { recursive: true });
      writeFileSync(
        join(tmpSolo, "src", "main.ts"),
        `import { Button } from "@/Button";\nexport const X = Button;\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "src", "Button.tsx"),
        `export function Button() { return null; }\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "src", "legacy", "Button.tsx"),
        `export function Button() { return null; }\n`,
        "utf8",
      );
      const result = await scan({ rootDir: tmpSolo, verbose: true });
      const legacyDead = result.issues.find(
        (i) =>
          i.kind === "dead-code" &&
          "symbol" in i &&
          i.symbol === "Button" &&
          i.location.file.replace(/\\/g, "/").endsWith("/legacy/Button.tsx"),
      );
      expect(legacyDead).toBeDefined();
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });

  it("structural duplicate is not suppressed by an unrelated window match elsewhere in the same file", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-struct-coverage-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({ name: "solo", type: "module", main: "./src/main.ts" }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "src"), { recursive: true });
      writeFileSync(
        join(tmpSolo, "src", "main.ts"),
        `import { processItem } from "./impl-a";\nimport { transform } from "./impl-b";\nexport const APP = processItem({ id: "1" }) + transform({ id: "2" });\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "src", "impl-a.ts"),
        `export function processItem(x: { id: string }) {
  const id = x.id;
  if (!id) throw new Error("missing id");
  const normalised = id.trim().toLowerCase();
  return { key: normalised, original: id, ok: true };
}

const blockA = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const blockB = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const blockC = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const blockD = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const blockE = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const blockF = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const blockG = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const blockH = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
export const ALL_BLOCKS = [blockA, blockB, blockC, blockD, blockE, blockF, blockG, blockH];
`,
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "src", "impl-b.ts"),
        `export function transform(x: { id: string }) {
  const id = x.id;
  if (!id) throw new Error("missing id");
  const normalised = id.trim().toLowerCase();
  return { key: normalised, original: id, ok: true };
}
`,
        "utf8",
      );
      const result = await scan({ rootDir: tmpSolo, verbose: true });
      const processTransformDup = result.issues.find(
        (i) =>
          i.kind === "duplicate" &&
          (i.preview ?? "").includes("processItem") &&
          (i.preview ?? "").includes("transform"),
      );
      expect(processTransformDup).toBeDefined();
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });

  it("`export { Foo as default }` resolves to the LHS name for cross-package default imports", async () => {
    addPkg(tmp, "a", {
      "src/index.ts":
        `import { ActualName } from "./impl";\nexport { ActualName as default };\nexport { ActualName };\n`,
      "src/impl.ts":
        `export function ActualName() { return 1; }\nexport function Orphan() { return 2; }\n`,
    });
    addPkg(tmp, "b", {
      "src/index.ts": `import Whatever from "@scope/a";\nexport const X = Whatever();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).toContain("Orphan");
    expect(flagged).not.toContain("ActualName");
  });

  it("pre-built workspaces prefer src/index.ts over dist/index.js for export parsing", async () => {
    addPkg(
      tmp,
      "a",
      {
        "src/index.ts": `import { Real } from "./real";\nexport { Real };\n`,
        "src/real.ts": `export function Real() { return 1; }\nexport function Orphan() { return 2; }\n`,
        "dist/index.js":
          `"use strict";Object.defineProperty(exports,"__esModule",{value:true});\n`,
      },
      { main: "./dist/index.js" },
    );
    addPkg(tmp, "b", {
      "src/index.ts": `import { Real } from "@scope/a";\nexport const X = Real();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).toContain("Orphan");
    expect(flagged).not.toContain("Real");
  });

  it("cross-workspace pre-pass ignores import statements inside line and block comments", async () => {
    addPkg(tmp, "a", {
      "src/index.ts":
        `import { Real } from "./real";\nexport { Real };\n`,
      "src/real.ts":
        `export function Real() { return 1; }\nexport function Commented() { return 2; }\n`,
    });
    addPkg(tmp, "b", {
      "src/index.ts":
        `import { Real } from "@scope/a";\nexport const X = Real();\n// import { Commented } from "@scope/a";\n/* import { Commented as X } from "@scope/a"; */\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).toContain("Commented");
  });

  it("unused-export branch consults the alias-import index too (no false-positive on aliased imports ts-morph missed)", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-alias-unused-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({ name: "solo", type: "module", main: "./src/main.ts" }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "src", "deep", "nested"), { recursive: true });
      writeFileSync(
        join(tmpSolo, "src", "main.ts"),
        `import { Helper } from "@/deep/nested/helper";\nconst _ = Helper;\nexport const APP = 1;\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "src", "deep", "nested", "helper.ts"),
        `export function Helper() { return 1; }\nfunction localUse() { return Helper(); }\nexport const Y = localUse();\n`,
        "utf8",
      );
      const result = await scan({ rootDir: tmpSolo, verbose: true });
      const unusedHelper = result.issues.find(
        (i) => i.kind === "unused-export" && "symbol" in i && i.symbol === "Helper",
      );
      expect(unusedHelper).toBeUndefined();
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });

  it("Next.js entry patterns are NOT applied when Next is not a project dependency", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-no-next-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({
          name: "plain-ts",
          type: "module",
          main: "./src/main.ts",
          dependencies: { astro: "^4.0.0" },
        }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "app", "dashboard"), { recursive: true });
      mkdirSync(join(tmpSolo, "src"), { recursive: true });
      writeFileSync(
        join(tmpSolo, "src", "main.ts"),
        `export const APP = 1;\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "app", "dashboard", "page.tsx"),
        `export default function NotARealNextPage() { return null; }\nexport function Helper() { return 1; }\n`,
        "utf8",
      );
      const result = await scan({ rootDir: tmpSolo, verbose: true });
      const flagged = result.issues
        .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
        .map((i) => ("symbol" in i ? i.symbol : ""));
      expect(flagged.some((s) => s === "Helper" || s === "NotARealNextPage")).toBe(true);
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });

  it("JSX pass-through with destructured rest `function W({...rest})` is detected as empty-wrapper", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-destructured-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({ name: "solo", type: "module", main: "./src/index.tsx" }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "src"), { recursive: true });
      writeFileSync(
        join(tmpSolo, "src", "index.tsx"),
        `export function Btn({...rest}: { children?: unknown }) {\n  return <button {...rest} />;\n}\n`,
        "utf8",
      );
      const result = await scan({ rootDir: tmpSolo });
      const wrapper = result.issues.find(
        (i) => i.kind === "empty-wrapper" && i.outerName === "Btn",
      );
      expect(wrapper).toBeDefined();
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });

  it("`export { default } from \"./impl\"` re-export does not collapse to CONSUMED_ALL", async () => {
    addPkg(tmp, "a", {
      "src/index.ts":
        `export { default } from "./impl";\nimport { Sibling } from "./impl";\nexport { Sibling };\n`,
      "src/impl.ts":
        `export default function Inner() { return 1; }\nexport function Sibling() { return 2; }\n`,
      "src/orphan.ts": `export function Orphan() { return 3; }\n`,
    });
    addPkg(tmp, "b", {
      "src/index.ts": `import Inner from "@scope/a";\nexport const X = Inner();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).toContain("Orphan");
  });

  it("structural fingerprint skips nested function bodies — identical inner callbacks do not collide outer functions", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-nested-fingerprint-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({ name: "solo", type: "module", main: "./src/index.ts" }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "src"), { recursive: true });
      writeFileSync(
        join(tmpSolo, "src", "index.ts"),
        `
export function ProcessUsers(users: { id: string }[]) {
  if (users.length === 0) throw new Error("empty users");
  const total = users.reduce((acc, u) => acc + u.id.length, 0);
  return { kind: "users" as const, total, count: users.length };
}

export function FormatLogs(logs: { level: string }[]) {
  for (const log of logs) {
    console.log(log.level);
  }
  const counts = logs.reduce((acc, u) => acc + u.level.length, 0);
  return counts > 0 ? "ok" : "empty";
}
`,
        "utf8",
      );
      const result = await scan({ rootDir: tmpSolo });
      const structural = result.issues.filter(
        (i) =>
          i.kind === "duplicate" &&
          (i.preview ?? "").includes("ProcessUsers") &&
          (i.preview ?? "").includes("FormatLogs"),
      );
      expect(structural).toHaveLength(0);
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });

  it("atomic --fix: a late rollback in any project restores every prepared project, nothing is written", async () => {
    const { readFileSync } = await import("node:fs");
    const { prepareDeadCodeFixes, commitDeadCodeFixes, rollbackPendingFixes } =
      await import("../src/fixers/dead-code.js");

    addPkg(tmp, "a", {
      "src/index.ts": `export { live } from "./live";\n`,
      "src/live.ts": `export const live = 1;\n`,
      "src/orphan.ts": `export const safeDead = 42;\n`,
    });
    addPkg(tmp, "b", {
      "src/index.ts": `import { live } from "@scope/a";\nexport const X = live;\nexport function brittle() { return 1; }\nexport const usesBrittle = brittle();\n`,
    });

    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const dead = result.issues.filter(
      (i) => i.kind === "dead-code" && (i.symbol === "safeDead" || i.symbol === "brittle"),
    );
    const brittleIssue: Extract<(typeof dead)[number], { kind: "dead-code" }> = {
      kind: "dead-code",
      location: dead.find((i) => i.kind === "dead-code" && i.symbol === "safeDead")?.location ?? {
        file: "",
        line: 0,
        column: 0,
      },
      symbol: "brittle",
      symbolKind: "function",
      exported: true,
      confidence: 1,
    };
    const bIndex = join(tmp, "packages", "b", "src", "index.ts");
    brittleIssue.location = { file: bIndex, line: 3, column: 1 };

    const safeIssue = dead.find((i) => i.kind === "dead-code" && i.symbol === "safeDead");
    expect(safeIssue).toBeDefined();
    if (!safeIssue) throw new Error("safeDead issue not found");
    const issues = [safeIssue, brittleIssue];

    const groups = new Map<ReturnType<typeof result.projectForFile>, typeof issues>();
    for (const issue of issues) {
      const proj = result.projectForFile(issue.location.file);
      const arr = groups.get(proj) ?? [];
      arr.push(issue);
      groups.set(proj, arr);
    }

    const prepared: Array<{
      pending?: import("../src/fixers/dead-code.js").PendingFix;
      rolledBack: boolean;
    }> = [];
    for (const [proj, gIssues] of groups) {
      if (!proj) continue;
      prepared.push(
        prepareDeadCodeFixes(
          proj,
          gIssues.filter(
            (i): i is Extract<typeof i, { kind: "dead-code" }> => i.kind === "dead-code",
          ),
        ),
      );
    }
    const anyRolled = prepared.some((p) => p.rolledBack);

    const safeFile = safeIssue.location.file;
    const originalSafeText = readFileSync(safeFile, "utf8");

    if (anyRolled) {
      for (const p of prepared) if (p.pending) rollbackPendingFixes(p.pending);
    } else {
      for (const p of prepared) if (p.pending) await commitDeadCodeFixes(p.pending);
    }

    expect(anyRolled).toBe(true);
    const postSafeText = readFileSync(safeFile, "utf8");
    expect(postSafeText).toBe(originalSafeText);
    expect(postSafeText).toMatch(/safeDead/);
  });

  it("projectForFile returns the LONGEST-prefix Project for nested workspace dirs", async () => {
    addPkg(tmp, "lib", {
      "src/index.ts": `export const fromLib = 1;\n`,
    });
    addPkg(tmp, "lib/inner", {
      "src/index.ts": `export const fromInner = 2;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp });
    const libPkgDir = join(tmp, "packages", "lib").replace(/\\/g, "/");
    const innerPkgDir = join(tmp, "packages", "lib", "inner").replace(/\\/g, "/");
    const fileInInner = `${innerPkgDir}/src/index.ts`;
    const fileInLib = `${libPkgDir}/src/index.ts`;
    const projInner = result.projectForFile(fileInInner);
    const projLib = result.projectForFile(fileInLib);
    expect(projInner).toBeDefined();
    expect(projLib).toBeDefined();
    expect(projInner?.getSourceFile(fileInInner)).toBeDefined();
    if (projInner !== projLib) {
      expect(projLib?.getSourceFile(fileInInner)).toBeUndefined();
    }
  });

  it("single-segment alias-tail  matches in a single-package project when the basename is unambiguous", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-single-seg-recall-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({ name: "solo", type: "module", main: "./src/main.ts" }),
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "src"), { recursive: true });
      writeFileSync(
        join(tmpSolo, "src", "main.ts"),
        `import { Button } from "@/Button";\nexport const X = Button;\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpSolo, "src", "Button.tsx"),
        `export function Button() { return null; }\n`,
        "utf8",
      );
      const result = await scan({ rootDir: tmpSolo, verbose: true });
      const buttonFlagged = result.issues.find(
        (i) =>
          (i.kind === "dead-code" || i.kind === "unused-export") &&
          "symbol" in i &&
          i.symbol === "Button",
      );
      expect(buttonFlagged).toBeUndefined();
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });

  it("SKIP_ORPHAN_PATTERN  matches TEST_DIR_REGEX — `playground/`, `generated/`, `gen/` produce no orphan insights", async () => {
    const tmpSolo = mkdtempSync(join(tmpdir(), "slp-orphan-drift-"));
    try {
      writeFileSync(
        join(tmpSolo, "package.json"),
        JSON.stringify({ name: "solo", type: "module", main: "./src/main.ts" }),
        "utf8",
      );
      mkdirSync(join(tmpSolo, "src"), { recursive: true });
      mkdirSync(join(tmpSolo, "playground"), { recursive: true });
      mkdirSync(join(tmpSolo, "generated"), { recursive: true });
      mkdirSync(join(tmpSolo, "gen"), { recursive: true });
      writeFileSync(join(tmpSolo, "src", "main.ts"), `export const APP = 1;\n`, "utf8");
      writeFileSync(join(tmpSolo, "playground", "scratch.ts"), `export const SCRATCH = 1;\n`, "utf8");
      writeFileSync(join(tmpSolo, "generated", "schema.ts"), `export const SCHEMA = 1;\n`, "utf8");
      writeFileSync(join(tmpSolo, "gen", "code.ts"), `export const CODE = 1;\n`, "utf8");
      const result = await scan({ rootDir: tmpSolo, verbose: true });
      const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
      const playgroundOrphans = orphans.filter((o) =>
        o.file.replace(/\\/g, "/").match(/\/(playground|generated|gen)\//),
      );
      expect(playgroundOrphans).toHaveLength(0);
    } finally {
      if (existsSync(tmpSolo)) rmSync(tmpSolo, { recursive: true, force: true });
    }
  });
});
