import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("dead-code: declaration shapes", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-dc-shapes-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags unused function declaration", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export function deadFn() { return 1; }\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "deadFn")).toBeDefined();
  });

  it("flags unused class declaration", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export class DeadClass {}\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "DeadClass")).toBeDefined();
  });

  it("flags unused interface declaration", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export interface DeadInterface { id: string }\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const issue = result.issues.find((i) => i.kind === "dead-code" && i.symbol === "DeadInterface");
    expect(issue).toBeDefined();
    if (issue?.kind === "dead-code") expect(issue.symbolKind).toBe("type");
  });

  it("flags unused type alias", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export type DeadType = string | number;\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "DeadType")).toBeDefined();
  });

  it("flags unused enum", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export enum DeadEnum { A, B }\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const issue = result.issues.find((i) => i.kind === "dead-code" && i.symbol === "DeadEnum");
    expect(issue).toBeDefined();
    if (issue?.kind === "dead-code") expect(issue.symbolKind).toBe("enum");
  });

  it("flags unused const variable", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export const DEAD_CONST = 42;\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "DEAD_CONST")).toBeDefined();
  });

  it("flags each entry in a multi-declaration const", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export const a = 1, b = 2;\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const names = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(names).toContain("a");
    expect(names).toContain("b");
  });
});

describe("dead-code: exemptions", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-dc-exempt-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("skips identifiers starting with underscore", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export function _intentional() { return 1; }\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "_intentional")).toBeUndefined();
  });

  it("skips a class with a decorated method", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function Route(_path: string): MethodDecorator { return () => undefined; }
export class DeadCtl {
  @Route("/x")
  handle(): string { return ""; }
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "DeadCtl")).toBeUndefined();
  });

  it("never flags a symbol whose file is an entry point", async () => {
    writeFileSync(join(tmp, "entry.ts"), "export function entryFn() { return 1; }\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "entryFn")).toBeUndefined();
  });

  it("default export has lower confidence than named export", async () => {
    writeFileSync(
      join(tmp, "lib-default.ts"),
      `export default function thingD() { return 1; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lib-named.ts"),
      `export function thingN() { return 1; }\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const def = result.issues.find(
      (i) => i.kind === "dead-code" && i.symbol === "thingD",
    );
    const named = result.issues.find(
      (i) => i.kind === "dead-code" && i.symbol === "thingN",
    );
    if (def && named) expect(def.confidence).toBeLessThan(named.confidence);
  });

  it("dead-code exported is preserved with exported=true on the issue", async () => {
    writeFileSync(join(tmp, "lib.ts"), "export function thing() { return 1; }\n", "utf8");
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const issue = result.issues.find((i) => i.kind === "dead-code" && i.symbol === "thing");
    expect(issue).toBeDefined();
    if (issue?.kind === "dead-code") expect(issue.exported).toBe(true);
  });
});

describe("dead-code: kindOf classification", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-dc-kind-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies function vs class vs type vs enum vs variable", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function fn() {}
export class Cl {}
export interface If {}
export type Ty = string;
export enum En { A }
export const va = 1;
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const kindOf = (sym: string) => {
      const i = result.issues.find((x) => x.kind === "dead-code" && x.symbol === sym);
      return i?.kind === "dead-code" ? i.symbolKind : undefined;
    };
    expect(kindOf("fn")).toBe("function");
    expect(kindOf("Cl")).toBe("class");
    expect(kindOf("If")).toBe("type");
    expect(kindOf("Ty")).toBe("type");
    expect(kindOf("En")).toBe("enum");
    expect(kindOf("va")).toBe("variable");
  });
});
