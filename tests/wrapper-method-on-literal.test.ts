import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

describe("empty-wrappers: method calls on inline literals are not wrappers", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-wrap-"));
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "package.json"), `{ "name": "t", "type": "module" }\n`, "utf8");
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does not flag a regex-encapsulating function", async () => {
    writeFileSync(
      join(tmp, "validators.ts"),
      `export function isValidEmail(s: string): boolean {\n  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(s);\n}\n` +
        `// keep alive\nexport const _all = { isValidEmail };\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).not.toContain("isValidEmail");
  });

  it("does not flag a function that wraps an array-literal .includes call", async () => {
    writeFileSync(
      join(tmp, "validators.ts"),
      `export function isVowel(c: string): boolean {\n  return ["a","e","i","o","u"].includes(c);\n}\n` +
        `export const _all = { isVowel };\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).not.toContain("isVowel");
  });

  it("still flags a true pass-through wrapper", async () => {
    writeFileSync(
      join(tmp, "users.ts"),
      `function fetchUser(id: string) { return { id }; }\nexport function getUser(id: string) { return fetchUser(id); }\n` +
        `export const _all = { getUser };\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).toContain("getUser");
  });
});
