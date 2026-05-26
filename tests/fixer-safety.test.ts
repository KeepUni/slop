import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";
import { applyDeadCodeFixes, planDeadCodeFixes } from "../src/fixers/dead-code.js";
import type { DeadCodeIssue } from "../src/detectors/types.js";

function setup(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", main: "./entry.ts" }),
    "utf8",
  );
  return tmp;
}

describe("fixer: diff plan", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-fix-plan-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("plans each removal with file, symbol, line range, and snippet", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export function used() { return 1; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function deadFn(x: number): number {\n  return x * 2;\n}\nexport const DEAD_CONST = 42;\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const dead = result.issues.filter((i): i is DeadCodeIssue => i.kind === "dead-code");
    const plans = planDeadCodeFixes(result.project, dead);

    const fn = plans.find((p) => p.symbol === "deadFn");
    expect(fn).toBeDefined();
    if (fn) {
      expect(fn.snippet).toContain("export function deadFn");
      expect(fn.snippet).toContain("return x * 2");
      expect(fn.endLine).toBeGreaterThan(fn.startLine);
    }

    const cst = plans.find((p) => p.symbol === "DEAD_CONST");
    expect(cst).toBeDefined();
    if (cst) {
      expect(cst.snippet).toContain("DEAD_CONST = 42");
      expect(cst.startLine).toBe(cst.endLine);
    }
  });
});

describe("fixer: post-removal verification", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-fix-verify-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("rolls back when removal would create a broken same-file reference", async () => {
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "lib.ts"),
      `const HELPER = 1;\nexport const USES = HELPER + 1;\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const fakeIssue: DeadCodeIssue = {
      kind: "dead-code",
      location: { file: join(tmp, "lib.ts").replace(/\\/g, "/"), line: 1, column: 1 },
      symbol: "HELPER",
      symbolKind: "variable",
      exported: false,
      confidence: 0.9,
    };
    const before = readFileSync(join(tmp, "lib.ts"), "utf8");

    const fixResult = await applyDeadCodeFixes(result.project, [fakeIssue]);

    expect(fixResult.rolledBack).toBe(true);
    expect(fixResult.brokenBy.length).toBeGreaterThan(0);
    expect(fixResult.brokenBy.some((b) => b.symbol === "HELPER")).toBe(true);
    expect(readFileSync(join(tmp, "lib.ts"), "utf8")).toBe(before);
  });

  it("commits when removal is genuinely safe", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export const APP = "yes";\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function trulyDead() { return 1; }\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const dead = result.issues.filter(
      (i): i is DeadCodeIssue => i.kind === "dead-code" && i.symbol === "trulyDead",
    );
    expect(dead).toHaveLength(1);

    const fixResult = await applyDeadCodeFixes(result.project, dead);
    expect(fixResult.rolledBack).toBe(false);
    expect(fixResult.brokenBy).toHaveLength(0);
    expect(fixResult.removedSymbols).toHaveLength(1);
    expect(readFileSync(join(tmp, "lib.ts"), "utf8")).not.toContain("trulyDead");
  });
});
