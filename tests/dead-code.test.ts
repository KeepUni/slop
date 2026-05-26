import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "dead-code");

describe("dead-code detector", () => {
  it("flags exported-but-unimported symbols", async () => {
    const result = await scan({ rootDir: FIXTURE_ROOT, only: ["dead-code"], verbose: true });
    const names = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(names).toContain("createHelper");
    expect(names).toContain("defaultConfig");
  });

  it("does not flag symbols that ARE imported elsewhere", async () => {
    const result = await scan({ rootDir: FIXTURE_ROOT, only: ["dead-code"], verbose: true });
    const names = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(names).not.toContain("greet");
  });
});
