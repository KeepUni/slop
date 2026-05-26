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

describe("code-smells: useless-async", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-useless-async-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags async function with no await and no Promise return", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export async function fetchUser(id: string) {
  return { id, name: "test" };
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    const findings = result.issues.filter((i) => i.kind === "useless-async");
    expect(findings).toHaveLength(1);
    if (findings[0]?.kind === "useless-async") {
      expect(findings[0].functionName).toBe("fetchUser");
    }
  });

  it("does NOT flag async function that uses await", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `async function inner(): Promise<number> { return 1 }
export async function outer() {
  return await inner();
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("does NOT flag async function that returns a Promise directly", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
export async function rejected() {
  return Promise.reject(new Error("nope"));
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("does NOT flag async function with for-await-of", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export async function consume(src: AsyncIterable<number>) {
  for await (const n of src) { console.log(n); }
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });
});

describe("code-smells: empty-catch", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-empty-catch-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags catch with empty block", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function risky() {
  try { JSON.parse("x") } catch (e) {}
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    const findings = result.issues.filter((i) => i.kind === "empty-catch");
    expect(findings).toHaveLength(1);
    if (findings[0]?.kind === "empty-catch") {
      expect(findings[0].swallowsAll).toBe(false);
    }
  });

  it("marks bare `catch {}` as swallowsAll", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function risky() {
  try { JSON.parse("x") } catch {}
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    const findings = result.issues.filter((i) => i.kind === "empty-catch");
    expect(findings).toHaveLength(1);
    if (findings[0]?.kind === "empty-catch") {
      expect(findings[0].swallowsAll).toBe(true);
    }
  });

  it("does NOT flag catch with content", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function risky() {
  try { JSON.parse("x") } catch (e) { console.error(e) }
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "empty-catch")).toHaveLength(0);
  });
});
