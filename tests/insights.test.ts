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

describe("insight: orphaned-file (reachability-based)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-insight-orphan-"));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  function setupEntryFixture(mainFile: string): void {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module", main: `./${mainFile}` }),
      "utf8",
    );
  }

  it("flags a file unreachable from the entry point", async () => {
    setupEntryFixture("entry.ts");
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "lonely.ts"),
      `export function alpha() { return 1; }
export function beta() { return 2; }
export function gamma() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(1);
    if (orphans[0].kind === "orphaned-file") {
      expect(orphans[0].file).toContain("lonely.ts");
    }
  });

  it("does NOT flag a file reached transitively through an import chain", async () => {
    setupEntryFixture("entry.ts");
    writeFileSync(
      join(tmp, "entry.ts"),
      `import { used } from "./mixed.js";\nexport const _ = used();\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "mixed.ts"),
      `export function used() { return 1; }
export function deadButHere() { return 2; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("does NOT flag a file reached via side-effect import", async () => {
    setupEntryFixture("entry.ts");
    writeFileSync(join(tmp, "entry.ts"), `import "./setup.js";\n`, "utf8");
    writeFileSync(
      join(tmp, "setup.ts"),
      `export function init() { return "ok"; }\nexport const VERSION = "1";\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("does NOT flag a file reached via dynamic import", async () => {
    setupEntryFixture("entry.ts");
    writeFileSync(
      join(tmp, "entry.ts"),
      `export async function go() { return import("./lazy.js"); }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lazy.ts"),
      `export function load() { return 42; }\nexport const _meta = { v: 1 };\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("does NOT flag tool-config files (postcss, tailwind, eslint, etc.)", async () => {
    setupEntryFixture("entry.ts");
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "postcss.config.mjs"),
      `export default { plugins: { "@tailwindcss/postcss": {} } };\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "tailwind.config.ts"),
      `export default { content: ["./src/**/*"] };\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("does NOT flag test files even when unreachable", async () => {
    setupEntryFixture("entry.ts");
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "thing.test.ts"),
      `export function testHelper() { return 1; }\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("silently skips the orphan check when no entry points exist", async () => {
    writeFileSync(
      join(tmp, "lonely.ts"),
      `export function alpha() { return 1; }\nexport function beta() { return 2; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module" }),
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("rolls up constituent DEAD issues so the user sees the file, not the rows", async () => {
    setupEntryFixture("entry.ts");
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "lonely.ts"),
      `export function alpha() { return 1; }
export function beta() { return 2; }
export function gamma() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(result.insights.filter((i) => i.kind === "orphaned-file")).toHaveLength(1);
    const deadFromOrphanedFile = result.issues
      .filter((i) => i.kind === "dead-code")
      .filter((i) => i.kind === "dead-code" && i.location.file.includes("lonely.ts"));
    expect(deadFromOrphanedFile).toHaveLength(0);

    const verbose = await scan({ rootDir: tmp, verbose: true });
    expect(verbose.insights.filter((i) => i.kind === "orphaned-file")).toHaveLength(1);
    const deadVerbose = verbose.issues
      .filter((i) => i.kind === "dead-code")
      .filter((i) => i.kind === "dead-code" && i.location.file.includes("lonely.ts"));
    expect(deadVerbose.length).toBeGreaterThanOrEqual(3);
  });
});

describe("insight: dead-wrapper-chain", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-insight-deadwrap-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a wrapper whose own symbol is unused", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function inner(a: number, b: number): number { return a + b; }
export function outer(a: number, b: number): number { return inner(a, b); }
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "use.ts"),
      `import { inner } from "./lib.js";\nexport const _ = inner(1, 2);\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const chains = result.insights.filter((i) => i.kind === "dead-wrapper-chain");
    expect(chains).toHaveLength(1);
    expect(chains[0].kind === "dead-wrapper-chain" && chains[0].outerName).toBe("outer");
  });

  it("does NOT fire when the wrapper IS used somewhere", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function inner(a: number, b: number): number { return a + b; }
export function outer(a: number, b: number): number { return inner(a, b); }
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "use.ts"),
      `import { outer } from "./lib.js";\nexport const _ = outer(1, 2);\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const chains = result.insights.filter((i) => i.kind === "dead-wrapper-chain");
    expect(chains).toHaveLength(0);
  });
});

describe("insight: dead-duplicate-pair", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-insight-dupdead-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a duplicate whose both sides are themselves dead", async () => {
    const body = `function ${"NAME"}(input: number): number {
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
    writeFileSync(join(tmp, "a.ts"), `export ${body.replace("NAME", "alpha")}`, "utf8");
    writeFileSync(join(tmp, "b.ts"), `export ${body.replace("NAME", "beta")}`, "utf8");

    const result = await scan({ rootDir: tmp });
    const pairs = result.insights.filter((i) => i.kind === "dead-duplicate-pair");
    expect(pairs).toHaveLength(1);
    if (pairs[0].kind === "dead-duplicate-pair") {
      const allSymbols = new Set([pairs[0].primarySymbol, ...pairs[0].matchSymbols]);
      expect(allSymbols.has("alpha")).toBe(true);
      expect(allSymbols.has("beta")).toBe(true);
    }
  });
});

describe("insight: wrapper-only-file", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-insight-wraponly-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a file whose majority of exports are empty wrappers", async () => {
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(
      join(tmp, "lib", "wrappers.ts"),
      `export function inner(a: number, b: number): number { return a + b; }
export function passA(a: number, b: number): number { return inner(a, b); }
export function passB(a: number, b: number): number { return inner(a, b); }
export function passC(a: number, b: number): number { return inner(a, b); }
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "main.ts"),
      `import { passA, passB, passC } from "./lib/wrappers.js";
export const _ = [passA(1, 2), passB(3, 4), passC(5, 6)];
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const wraps = result.insights.filter((i) => i.kind === "wrapper-only-file");
    expect(wraps).toHaveLength(1);
    if (wraps[0].kind === "wrapper-only-file") {
      expect(wraps[0].wrapperCount).toBeGreaterThanOrEqual(3);
      expect(wraps[0].totalExports).toBeGreaterThanOrEqual(wraps[0].wrapperCount);
    }
  });
});

describe("insight: confidence inheritance", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-insight-conf-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("orphaned-file confidence is in [0, 1]", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module", main: "./entry.ts" }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "lonely.ts"),
      `export function a() { return 1; }
export function b() { return 2; }
export function c() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const insight = result.insights.find((i) => i.kind === "orphaned-file");
    expect(insight).toBeDefined();
    expect(insight?.confidence).toBeGreaterThanOrEqual(0);
    expect(insight?.confidence).toBeLessThanOrEqual(1);
  });
});
