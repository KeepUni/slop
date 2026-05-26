import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "empty-wrappers");

describe("empty-wrappers detector", () => {
  it("flags pure pass-through wrappers", async () => {
    const result = await scan({ rootDir: FIXTURE_ROOT, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).toContain("getUser");
  });

  it("does not flag wrappers that add behavior", async () => {
    const result = await scan({ rootDir: FIXTURE_ROOT, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).not.toContain("getUserWithFallback"); // has default arg
    expect(wrappers).not.toContain("findUser"); // arg order swapped
    expect(wrappers).not.toContain("getUpperUser"); // transforms arg
  });
});
