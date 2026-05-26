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

describe("ai-signatures: useless type predicates", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-pred-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags typeof-only predicate", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `export function isString(x: unknown): x is string {
  return typeof x === "string";
}
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const preds = result.issues.filter((i) => i.kind === "useless-type-predicate");
    expect(preds).toHaveLength(1);
    if (preds[0].kind === "useless-type-predicate") {
      expect(preds[0].predicateName).toBe("isString");
      expect(preds[0].collapsesTo).toContain("typeof");
      expect(preds[0].collapsesTo).toContain("string");
    }
  });

  it("does NOT flag .includes() type predicates (TS does not narrow on Array.includes)", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `const SITES = ["a", "b", "c"] as const;
type Site = (typeof SITES)[number];
export function isSite(value: string): value is Site {
  return (SITES as readonly string[]).includes(value);
}
const KINDS = ["a", "b"];
export function isKind(v: string): v is "a" | "b" {
  return KINDS.includes(v);
}
class Container { list: string[] = []; }
const obj = new Container();
export function isMember(v: string): v is string {
  return obj.list.includes(v);
}
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const preds = result.issues.filter((i) => i.kind === "useless-type-predicate");
    expect(preds).toHaveLength(0);
  });

  it("flags Array.isArray predicate", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `export function isArr(x: unknown): x is unknown[] {
  return Array.isArray(x);
}
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const preds = result.issues.filter((i) => i.kind === "useless-type-predicate");
    expect(preds).toHaveLength(1);
    if (preds[0].kind === "useless-type-predicate") {
      expect(preds[0].collapsesTo).toContain("Array.isArray");
    }
  });

  it("flags instanceof predicate", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `export function isErr(x: unknown): x is Error {
  return x instanceof Error;
}
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const preds = result.issues.filter((i) => i.kind === "useless-type-predicate");
    expect(preds).toHaveLength(1);
    if (preds[0].kind === "useless-type-predicate") {
      expect(preds[0].collapsesTo).toContain("instanceof");
    }
  });

  it("flags arrow predicate with expression body", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `export const isNumber = (x: unknown): x is number => typeof x === "number";
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const preds = result.issues.filter((i) => i.kind === "useless-type-predicate");
    expect(preds).toHaveLength(1);
  });

  it("does NOT flag a predicate with real shape-narrowing work", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `export interface User { id: string; name: string }
export function isUser(x: unknown): x is User {
  return (
    typeof x === "object" &&
    x !== null &&
    "id" in x &&
    "name" in x &&
    typeof (x as { id: unknown }).id === "string"
  );
}
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const preds = result.issues.filter((i) => i.kind === "useless-type-predicate");
    expect(preds).toHaveLength(0);
  });

  it("does NOT flag a non-predicate boolean function", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `export function checkString(x: unknown): boolean {
  return typeof x === "string";
}
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const preds = result.issues.filter((i) => i.kind === "useless-type-predicate");
    expect(preds).toHaveLength(0);
  });
});

describe("ai-signatures: same-shape types", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-shape-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags two interfaces with identical 3-field shape", async () => {
    writeFileSync(
      join(tmp, "types.ts"),
      `export interface UserDTO {
  id: string;
  name: string;
  email: string;
}
export interface UserModel {
  id: string;
  name: string;
  email: string;
}
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const sameShape = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(sameShape).toHaveLength(1);
    if (sameShape[0].kind === "same-shape-types") {
      const names = new Set([
        sameShape[0].primaryName,
        ...sameShape[0].matchNames,
      ]);
      expect(names.has("UserDTO")).toBe(true);
      expect(names.has("UserModel")).toBe(true);
      expect(sameShape[0].fieldCount).toBe(3);
    }
  });

  it("flags an interface and a type-alias with the same shape", async () => {
    writeFileSync(
      join(tmp, "types.ts"),
      `export interface Order { id: string; total: number; status: string }
export type Receipt = { id: string; total: number; status: string };
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const sameShape = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(sameShape).toHaveLength(1);
  });

  it("does NOT flag shapes with fewer than 3 fields", async () => {
    writeFileSync(
      join(tmp, "types.ts"),
      `export interface A { id: string; name: string }
export interface B { id: string; name: string }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const sameShape = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(sameShape).toHaveLength(0);
  });

  it("does NOT flag shapes that differ in a field type", async () => {
    writeFileSync(
      join(tmp, "types.ts"),
      `export interface UserA { id: string; age: number; email: string }
export interface UserB { id: number; age: number; email: string }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const sameShape = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(sameShape).toHaveLength(0);
  });

  it("lowers confidence when both types live in layered-architecture folders", async () => {
    mkdirSync(join(tmp, "dto"), { recursive: true });
    mkdirSync(join(tmp, "model"), { recursive: true });
    writeFileSync(
      join(tmp, "dto", "user.ts"),
      `export interface UserDTO { id: string; name: string; email: string }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "model", "user.ts"),
      `export interface UserModel { id: string; name: string; email: string }\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const sameShape = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(sameShape).toHaveLength(1);
    expect(sameShape[0].confidence).toBeLessThan(0.8);
  });
});

describe("ai-signatures: over-abstraction chain insight", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-chain-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a 3-deep chain of wrappers in one file", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function realFn(id: string): string { return id + "!"; }
export function inner(id: string): string { return realFn(id); }
export function mid(id: string): string { return inner(id); }
export function outer(id: string): string { return mid(id); }
export const _use = outer("x");
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const chains = result.insights.filter((i) => i.kind === "over-abstraction-chain");
    expect(chains).toHaveLength(1);
    if (chains[0].kind === "over-abstraction-chain") {
      expect(chains[0].chain.length).toBe(3);
      expect(chains[0].chain[0].name).toBe("outer");
      expect(chains[0].terminalCall).toBe("realFn");
    }
  });

  it("does NOT flag a 2-deep chain (one wrapper around a real fn)", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function realFn(id: string): string { return id + "!"; }
export function outer(id: string): string { return realFn(id); }
export const _use = outer("x");
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const chains = result.insights.filter((i) => i.kind === "over-abstraction-chain");
    expect(chains).toHaveLength(0);
  });

  it("rolls up the constituent wrapper issues into the insight", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function realFn(id: string): string { return id + "!"; }
export function inner(id: string): string { return realFn(id); }
export function mid(id: string): string { return inner(id); }
export function outer(id: string): string { return mid(id); }
export const _use = outer("x");
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(result.insights.filter((i) => i.kind === "over-abstraction-chain")).toHaveLength(1);
    const wrappers = result.issues.filter((i) => i.kind === "empty-wrapper");
    expect(wrappers).toHaveLength(0);

    const verbose = await scan({ rootDir: tmp, verbose: true });
    expect(verbose.insights.filter((i) => i.kind === "over-abstraction-chain")).toHaveLength(1);
    const verboseWrappers = verbose.issues.filter((i) => i.kind === "empty-wrapper");
    expect(verboseWrappers.length).toBeGreaterThanOrEqual(3);
  });
});
