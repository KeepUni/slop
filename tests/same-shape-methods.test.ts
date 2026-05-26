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

describe("same-shape-types: methods are part of the shape", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-same-shape-methods-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag two interfaces with identical fields but different methods", async () => {
    writeFileSync(
      join(tmp, "a.ts"),
      `export interface Bag<K, V> {
  key: K;
  value: V;
  tag: "bag";
}
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "b.ts"),
      `export interface Map<K, V> {
  key: K;
  value: V;
  tag: "bag";
  min(n: number): this;
  max(n: number): this;
  nonempty(): this;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(result.issues.filter((i) => i.kind === "same-shape-types")).toHaveLength(0);
  });

  it("still flags two interfaces with identical fields AND identical methods", async () => {
    writeFileSync(
      join(tmp, "a.ts"),
      `export interface Foo {
  a: string;
  b: number;
  greet(): string;
}
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "b.ts"),
      `export interface Bar {
  a: string;
  b: number;
  greet(): string;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    const findings = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(findings).toHaveLength(1);
  });
});
