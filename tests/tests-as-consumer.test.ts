import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";
import { isTestFilePath } from "../src/core/config.js";

function setup(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("test files: path detection is rootDir-relative", () => {
  it("treats *.test.ts anywhere as test by filename", () => {
    const root = "/some/project";
    expect(isTestFilePath("/some/project/src/foo.test.ts", root)).toBe(true);
    expect(isTestFilePath("/some/project/lib/bar.spec.tsx", root)).toBe(true);
  });

  it("treats tests/ subdir as test only when under rootDir", () => {
    const root = "/some/project";
    expect(isTestFilePath("/some/project/tests/setup.ts", root)).toBe(true);
    expect(isTestFilePath("/some/project/src/file.ts", root)).toBe(false);
  });

  it("does NOT mark a project AT tests/fixtures/X as tests", () => {
    const root = "/repo/tests/fixtures/X";
    expect(isTestFilePath("/repo/tests/fixtures/X/lib/foo.ts", root)).toBe(false);
    expect(isTestFilePath("/repo/tests/fixtures/X/index.ts", root)).toBe(false);
  });

  it("recognizes common test-setup filenames", () => {
    const root = "/some/project";
    expect(isTestFilePath("/some/project/vitestSetup.ts", root)).toBe(true);
    expect(isTestFilePath("/some/project/jest.setup.ts", root)).toBe(true);
    expect(isTestFilePath("/some/project/setupTests.ts", root)).toBe(true);
  });
});

describe("test files: contribute references but don't emit findings", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-tests-consumer-");
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

  it("a symbol used only by a test file is NOT flagged dead", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "helper.ts"),
      `export function productionHelper(n: number): number { return n * 2; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "helper.test.ts"),
      `import { productionHelper } from "./helper.js";
const result = productionHelper(7);
console.log(result);
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const flagged = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.symbol === "productionHelper",
    );
    expect(flagged).toBeUndefined();
  });

  it("detectors don't emit findings FROM inside test files", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "real.ts"),
      `export function compute(n: number): number { return n + 1; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "real.test.ts"),
      `import { compute } from "./real.js";
function makeCase(n: number) {
  return compute(n);
}
console.log(makeCase(3));
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const inTest = result.issues.filter((i) =>
      ("location" in i ? i.location.file : i.primary.file)
        .replace(/\\/g, "/")
        .includes("real.test.ts"),
    );
    expect(inTest).toHaveLength(0);
  });
});
