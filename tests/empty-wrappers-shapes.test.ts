import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setup(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module" }),
    "utf8",
  );
  return tmp;
}

describe("empty-wrappers: declaration shapes", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-wrapper-shapes-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags function declaration wrapper", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(x: number, y: number) { return x + y; }
export function outer(x: number, y: number) { return inner(x, y); }
export const _u = outer(1, 2);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeDefined();
  });

  it("flags arrow-function variable wrapper", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(x: number, y: number) { return x + y; }
export const outer = (x: number, y: number) => inner(x, y);
export const _u = outer(1, 2);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeDefined();
  });

  it("flags arrow-function with block body", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(x: number, y: number) { return x + y; }
export const outer = (x: number, y: number) => { return inner(x, y); };
export const _u = outer(1, 2);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeDefined();
  });

  it("flags awaited wrapper of async inner", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `async function inner(x: number) { return x + 1; }
export async function outer(x: number) { return await inner(x); }
export const _u = outer(1);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeDefined();
  });
});

describe("empty-wrappers: negative cases", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-wrapper-neg-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag recursive function", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function fact(n: number): number { return fact(n); }
export const _u = fact(1);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "fact")).toBeUndefined();
  });

  it("does NOT flag arg-order swap", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(x: number, y: number) { return x - y; }
export function outer(x: number, y: number) { return inner(y, x); }
export const _u = outer(1, 2);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeUndefined();
  });

  it("does NOT flag arg count mismatch (partial application)", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(x: number, y: number, z: number) { return x + y + z; }
export function outer(x: number, y: number) { return inner(x, y, 0); }
export const _u = outer(1, 2);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeUndefined();
  });

  it("does NOT flag wrappers with default-value parameter", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(x: number, y: number) { return x + y; }
export function outer(x: number, y: number = 5) { return inner(x, y); }
export const _u = outer(1);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeUndefined();
  });

  it("does NOT flag wrappers with rest parameter", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(...n: number[]) { return n.length; }
export function outer(...n: number[]) { return inner(...n); }
export const _u = outer(1, 2);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeUndefined();
  });

  it("does NOT flag transformed argument", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function inner(s: string) { return s; }
export function outer(s: string) { return inner(s.toUpperCase()); }
export const _u = outer("a");
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "outer")).toBeUndefined();
  });

  it("does NOT flag class method that overrides parent", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `class Base { greet(): string { return "hi"; } }
function inner(): string { return "hello"; }
export class Sub extends Base {
  greet(): string { return inner(); }
}
export const _u = new Sub();
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "greet")).toBeUndefined();
  });

  it("does NOT flag method on a class that implements an interface", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `interface I { greet(): string }
function inner(): string { return "hi"; }
export class Impl implements I {
  greet(): string { return inner(); }
}
export const _u = new Impl();
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "greet")).toBeUndefined();
  });
});
