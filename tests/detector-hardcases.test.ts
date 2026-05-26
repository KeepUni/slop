import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setup(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", main: "./entry.ts" }),
    "utf8",
  );
  writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
  return tmp;
}

describe("hard cases: TS declaration merging", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-hard-merge-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does not crash on `class X` + `namespace X` (declaration merging)", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export class Box { kind = "box" as const; }
export namespace Box {
  export const DEFAULT = new Box();
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it("does not flag `class X` as dead when only `namespace X` uses it", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `import { Box } from "./lib"; export const D = Box.DEFAULT;\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lib.ts"),
      `export class Box { kind = "box" as const; }
export namespace Box {
  export const DEFAULT = new Box();
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "Box")).toBeUndefined();
  });
});

describe("hard cases: useless-type-predicate edge cases", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-hard-pred-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag discriminated-union predicate `value.kind === 'foo'`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `type A = { kind: "a"; payload: string };
type B = { kind: "b"; n: number };
type AB = A | B;
export function isA(v: AB): v is A {
  return v.kind === "a";
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(result.issues.filter((i) => i.kind === "useless-type-predicate")).toHaveLength(0);
  });

  it("does NOT flag multi-condition predicate", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function isPositiveInt(x: unknown): x is number {
  return typeof x === "number" && x > 0 && Number.isInteger(x);
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(result.issues.filter((i) => i.kind === "useless-type-predicate")).toHaveLength(0);
  });
});

describe("hard cases: top-level await", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-hard-tla-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("handles top-level await in module without crashing", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `const x = await Promise.resolve(1); export const Y = x + 1;\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp });
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});

describe("hard cases: barrel re-export chains with aliases", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-hard-barrel-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("follows `export { foo as bar } from './x'` chain to keep foo alive", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module", main: "./src/index.ts" }),
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "index.ts"),
      `export { internalFoo as foo } from "./internal";\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "internal.ts"),
      `export function internalFoo() { return 1; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "consumer.ts"),
      `import { foo } from "./index"; export const X = foo();\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(
      result.issues.find((i) => i.kind === "dead-code" && i.symbol === "internalFoo"),
    ).toBeUndefined();
  });
});

describe("hard cases: duplicates do not false-positive on tiny differences", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-hard-dup-tiny-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does not group two function bodies whose tokens differ in operators / control flow", async () => {
    writeFileSync(
      join(tmp, "a.ts"),
      `export function addAll(items: number[]): number {
  let total = 0;
  for (const item of items) {
    if (item > 0) {
      total += item;
    } else {
      total -= item;
    }
  }
  return total;
}
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "b.ts"),
      `export function pickFirst(items: number[]): number | undefined {
  for (const item of items) {
    if (item === 0) continue;
    return item;
  }
  return undefined;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    expect(result.issues.filter((i) => i.kind === "duplicate")).toHaveLength(0);
  });
});

describe("hard cases: scope-limited scan flags consumer-less symbols", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-hard-scope-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("reports symbols as dead when their callers are outside the scanned paths", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module", main: "./src/index.ts" }),
      "utf8",
    );
    writeFileSync(join(tmp, "src", "index.ts"), `export const ROOT = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "src", "helper.ts"),
      `export function onlyTestsUse() { return 1; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "tests", "helper.test.ts"),
      `import { onlyTestsUse } from "../src/helper";
console.log(onlyTestsUse());
`,
      "utf8",
    );

    const full = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(
      full.issues.find((i) => i.kind === "dead-code" && i.symbol === "onlyTestsUse"),
    ).toBeUndefined();

    const scoped = await scan({
      rootDir: tmp,
      paths: ["src"],
      only: ["dead-code"],
      verbose: true,
    });
    expect(
      scoped.issues.find((i) => i.kind === "dead-code" && i.symbol === "onlyTestsUse"),
    ).toBeDefined();
  });
});

describe("hard cases: useless-async with for-await over array", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-hard-async-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag async fn with for-await over an async iterable", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export async function consume(src: AsyncIterable<number>) {
  for await (const _ of src) { /* drain */ }
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });
});
