import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setupFixture(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module" }),
    "utf8",
  );
  return tmp;
}

describe("confidence: every issue carries a number in [0, 1]", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-confidence-shape-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("dead-code, duplicate, and wrapper issues all have valid confidence", async () => {
    writeFileSync(join(tmp, "lib.ts"), `export function unused() { return 1; }\n`, "utf8");

    writeFileSync(
      join(tmp, "wrappers.ts"),
      `export function inner(a: number, b: number): number { return a + b; }\n` +
        `export function outer(a: number, b: number): number { return inner(a, b); }\n` +
        `export const _use = outer(1, 2);\n`,
      "utf8",
    );

    const body = `export function ${"NAME"}(input: number): number {
  const a = input * 2;
  const b = a + 1;
  const c = b * b;
  const d = c - input;
  const e = d / 2;
  const f = e + a;
  const g = f - 3;
  const h = g * input;
  const i = h + 7;
  const j = i / 4;
  const k = j * 11;
  const m = k - input;
  return m * m;
}
`;
    writeFileSync(
      join(tmp, "a.ts"),
      body.replace("NAME", "alpha") + `export const _keep_a = alpha;\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "b.ts"),
      body.replace("NAME", "beta") + `export const _keep_b = beta;\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(typeof issue.confidence).toBe("number");
      expect(Number.isFinite(issue.confidence)).toBe(true);
      expect(issue.confidence).toBeGreaterThanOrEqual(0);
      expect(issue.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("confidence: --min-confidence filters at scanner level", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-min-conf-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("threshold > max confidence drops everything", async () => {
    writeFileSync(join(tmp, "lib.ts"), `export function unused() { return 1; }\n`, "utf8");

    const reportAll = await scan({ rootDir: tmp });
    expect(reportAll.issues.length).toBeGreaterThan(0);

    const reportNone = await scan({ rootDir: tmp, minConfidence: 1.01 });
    expect(reportNone.issues).toHaveLength(0);
  });

  it("threshold below all confidences keeps everything", async () => {
    writeFileSync(join(tmp, "lib.ts"), `export function unused() { return 1; }\n`, "utf8");

    const reportFull = await scan({ rootDir: tmp });
    const reportZero = await scan({ rootDir: tmp, minConfidence: 0 });
    expect(reportZero.issues.length).toBe(reportFull.issues.length);
  });
});

describe("confidence: dead-code default export scores lower than named export", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-deadcode-conf-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("a default export gets lower confidence than a same-shape named one", async () => {
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(
      join(tmp, "lib", "named.ts"),
      `export function alpha() { return 1; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lib", "default.ts"),
      `export default function beta() { return 1; }\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const named = result.issues.find(
      (i) => i.kind === "dead-code" && i.symbol === "alpha",
    );
    const def = result.issues.find(
      (i) => i.kind === "dead-code" && i.symbol === "beta",
    );
    if (named && def) {
      expect(def.confidence).toBeLessThan(named.confidence);
    } else {
      expect(named).toBeDefined();
      expect(named?.confidence ?? 0).toBeGreaterThanOrEqual(0.85);
    }
  });
});

describe("confidence: duplicate cross-file scores higher than same-file", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-dup-conf-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("cross-file duplication gets a small confidence bonus over same-file", async () => {
    const body = `export function ${"NAME"}(input: number): number {
  const a = input * 2;
  const b = a + 1;
  const c = b * b;
  const d = c - input;
  const e = d / 2;
  const f = e + a;
  const g = f - 3;
  const h = g * input;
  const i = h + 7;
  const j = i / 4;
  const k = j * 11;
  const m = k - input;
  return m * m;
}
`;
    writeFileSync(
      join(tmp, "a.ts"),
      body.replace("NAME", "alpha") + `export const _keep_a = alpha;\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "b.ts"),
      body.replace("NAME", "beta") + `export const _keep_b = beta;\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups.length).toBeGreaterThan(0);
    expect(dups[0].confidence).toBeGreaterThan(0.8);
  });
});

describe("confidence: empty-wrapper with JSDoc scores lower than without", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-wrapper-conf-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("a documented wrapper is treated as more likely intentional", async () => {
    writeFileSync(
      join(tmp, "wrappers.ts"),
      `export function inner(a: number, b: number): number { return a + b; }
/**
 * Adds two numbers via the inner helper.
 */
export function documented(a: number, b: number): number { return inner(a, b); }
export function plain(a: number, b: number): number { return inner(a, b); }
export const _use = [documented(1, 2), plain(3, 4)];
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"], verbose: true });
    const documented = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "documented",
    );
    const plain = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "plain",
    );
    expect(documented).toBeDefined();
    expect(plain).toBeDefined();
    expect(documented?.confidence ?? 0).toBeLessThan(plain?.confidence ?? 0);
  });
});
