import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setup(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("entry-points: package.json#exports wildcards", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-exports-wildcard-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("treats every file matched by an exports wildcard as an entry point", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        exports: {
          ".": "./dist/index.js",
          "./utils/*": {
            types: "./dist/types/utils/*.d.ts",
            import: "./dist/utils/*.js",
          },
        },
      }),
      "utf8",
    );
    mkdirSync(join(tmp, "src", "utils"), { recursive: true });
    writeFileSync(join(tmp, "src", "index.ts"), `export const ROOT = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "src", "utils", "filepath.ts"),
      `export function getFilePath(name: string) { return name; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "utils", "headers.ts"),
      `export function getHeader(name: string) { return name; }\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const deadGetFilePath = result.issues.find(
      (i) => i.kind === "dead-code" && i.symbol === "getFilePath",
    );
    const deadGetHeader = result.issues.find(
      (i) => i.kind === "dead-code" && i.symbol === "getHeader",
    );
    expect(deadGetFilePath).toBeUndefined();
    expect(deadGetHeader).toBeUndefined();
    expect(
      result.insights.find(
        (i) => i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").includes("utils/"),
      ),
    ).toBeUndefined();
  });

  it("handles root-level wildcard exports (zustand-style ./*)", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        exports: {
          ".": "./index.js",
          "./*": { import: "./*.mjs", default: "./*.js" },
        },
      }),
      "utf8",
    );
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "index.ts"), `export const ROOT = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "src", "traditional.ts"),
      `export function useStoreWithEqualityFn() { return 1; }\nexport type Cfg = { x: number };\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(
      result.issues.find(
        (i) =>
          (i.kind === "dead-code" || i.kind === "unused-export") &&
          i.symbol === "useStoreWithEqualityFn",
      ),
    ).toBeUndefined();
  });

  it("does not mistake the literal asterisk as a real file", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        exports: { "./misc/*": "./dist/misc/*.js" },
      }),
      "utf8",
    );
    writeFileSync(join(tmp, "lonely.ts"), `export const LONELY = 1;\n`, "utf8");

    const result = await scan({ rootDir: tmp });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "LONELY")).toBeDefined();
  });
});

describe("orphan-file skip: extra test-infra dirs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-orphan-skip-");
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module", main: "./entry.ts" }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag files in perf-measures/, runtime-tests/, integration-tests/", async () => {
    for (const dir of ["perf-measures", "runtime-tests", "integration-tests", "smoke-tests"]) {
      mkdirSync(join(tmp, dir), { recursive: true });
      writeFileSync(
        join(tmp, dir, "main.ts"),
        `export function entry() { return 1; }\n`,
        "utf8",
      );
    }
    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });
});
