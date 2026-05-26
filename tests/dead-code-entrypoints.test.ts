import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("dead-code: entry-point discovery via imports", () => {
  it("treats files reached by dynamic import as entry points", async () => {
    const root = resolve(HERE, "fixtures", "dynamic-import");
    const result = await scan({ rootDir: root, only: ["dead-code"] });
    const deadSymbols = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(deadSymbols).not.toContain("init");
  });

  it("treats files reached by side-effect import as entry points", async () => {
    const root = resolve(HERE, "fixtures", "decorator");
    const result = await scan({ rootDir: root, only: ["dead-code"] });
    const deadFiles = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.location.file.replace(/\\/g, "/") : ""));
    expect(deadFiles.every((f) => !f.endsWith("/controller.ts"))).toBe(true);
  });
});

describe("dead-code: decorator-as-use heuristic", () => {
  it("does not flag a class whose methods are decorated", async () => {
    const root = resolve(HERE, "fixtures", "decorator");
    const result = await scan({ rootDir: root, only: ["dead-code"] });
    const deadSymbols = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(deadSymbols).not.toContain("UsersController");
  });
});

describe("project root: walk-up to find tsconfig", () => {
  it("resolves tsconfig.json#paths even when scanner runs from a subdirectory", async () => {
    const subdir = resolve(HERE, "fixtures", "paths-alias", "src");
    const result = await scan({ rootDir: subdir, only: ["dead-code"] });
    const deadSymbols = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(deadSymbols).not.toContain("helper");
  });
});
