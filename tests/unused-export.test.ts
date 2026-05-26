import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setupFixture(prefix: string, withMain = true): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({
      name: "fixture",
      type: "module",
      ...(withMain ? { main: "./entry.ts" } : {}),
    }),
    "utf8",
  );
  if (withMain) {
    writeFileSync(join(tmp, "entry.ts"), `import { used } from "./lib.js";\nused();\n`, "utf8");
  }
  return tmp;
}

describe("unused-export: classifies cross-file vs local use correctly", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-unused-export-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags an exported symbol used only inside its own file as unused-export, NOT dead-code", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function helper(x: number): number { return x + 1; }
export function used(): number { return helper(7); }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const helper = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.symbol === "helper",
    );
    expect(helper).toBeDefined();
    expect(helper?.kind).toBe("unused-export");
    if (helper?.kind === "unused-export") {
      expect(helper.localUses).toBeGreaterThan(0);
    }
  });

  it("flags a zero-ref symbol as dead-code, NOT unused-export", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function helper(x: number): number { return x + 1; }
export function used(): number { return 7; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const helper = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.symbol === "helper",
    );
    expect(helper).toBeDefined();
    expect(helper?.kind).toBe("dead-code");
  });

  it("does not flag a symbol used cross-file (entry imports it)", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `import { used, helper } from "./lib.js";\nconsole.log(used(), helper(3));\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function helper(x: number): number { return x + 1; }
export function used(): number { return helper(7); }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const flagged = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.symbol === "helper",
    );
    expect(flagged).toBeUndefined();
  });

  it("classifies an unused exported TYPE as unused-export when locally referenced", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export type Maybe<T> = T | null;
export function helper(x: Maybe<number>): number { return x ?? 0; }
export function used(): number { return helper(7); }
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "entry.ts"),
      `import { used } from "./lib.js";\nused();\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const maybe = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.symbol === "Maybe",
    );
    expect(maybe).toBeDefined();
    expect(["dead-code", "unused-export"]).toContain(maybe?.kind);
  });
});

describe("unused-export: confidence is softer than dead-code", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-unused-export-conf-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("unused-export confidence is below dead-code confidence on the same fixture shape", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function neverUsed(): number { return 1; }
export function localOnly(): number { return 2; }
export function entrypoint(): number { return localOnly(); }
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "entry.ts"),
      `import { entrypoint } from "./lib.js";\nconsole.log(entrypoint());\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const dead = result.issues.find(
      (i) => i.kind === "dead-code" && i.symbol === "neverUsed",
    );
    const unusedExp = result.issues.find(
      (i) => i.kind === "unused-export" && i.symbol === "localOnly",
    );
    expect(dead).toBeDefined();
    expect(unusedExp).toBeDefined();
    if (dead && unusedExp) {
      expect(unusedExp.confidence).toBeLessThan(dead.confidence);
    }
  });
});
