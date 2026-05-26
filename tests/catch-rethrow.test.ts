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
  writeFileSync(join(tmp, "entry.ts"), `export const APP = 1;\n`, "utf8");
  return tmp;
}

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(target.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(target, content, "utf8");
}

describe("empty-catch: pure rethrow patterns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-rethrow-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("`catch (e) { throw e; }` is flagged as empty-catch", async () => {
    write(
      tmp,
      "lib.ts",
      `export function bad() {
  try {
    JSON.parse("x");
  } catch (e) {
    throw e;
  }
  return 1;
}
export const _x = bad();
`,
    );
    const result = await scan({ rootDir: tmp });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(1);
  });

  it("catch with wrap `throw new Error(...)` is NOT flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `export function wrap() {
  try {
    JSON.parse("x");
  } catch (e) {
    throw new Error("wrapped: " + String(e));
  }
  return 1;
}
export const _x = wrap();
`,
    );
    const result = await scan({ rootDir: tmp });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(0);
  });

  it("catch with logging before rethrow is NOT flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `export function logged() {
  try {
    JSON.parse("x");
  } catch (e) {
    console.error(e);
    throw e;
  }
  return 1;
}
export const _x = logged();
`,
    );
    const result = await scan({ rootDir: tmp });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(0);
  });

  it("`catch (e) { throw e.cause; }` (semantic transform) is NOT flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `export function unwrap() {
  try {
    JSON.parse("x");
  } catch (e) {
    throw (e as { cause?: unknown }).cause;
  }
  return 1;
}
export const _x = unwrap();
`,
    );
    const result = await scan({ rootDir: tmp });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(0);
  });

  it("rethrow with underscore-prefixed parameter `catch (_e) { throw _e; }` is exempt (signaled intent)", async () => {
    write(
      tmp,
      "lib.ts",
      `export function intentional() {
  try {
    JSON.parse("x");
  } catch (_e) {
    throw _e;
  }
  return 1;
}
export const _x = intentional();
`,
    );
    const result = await scan({ rootDir: tmp });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(0);
  });
});
