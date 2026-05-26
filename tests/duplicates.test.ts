import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "duplicates");

describe("duplicates detector", () => {
  it("finds near-duplicate formatDate / formatDateString", async () => {
    const result = await scan({ rootDir: FIXTURE_ROOT, only: ["duplicates"] });
    expect(result.issues.length).toBeGreaterThan(0);

    const dup = result.issues.find((i) => i.kind === "duplicate");
    expect(dup).toBeDefined();
    if (dup?.kind !== "duplicate") throw new Error("unreachable");

    const files = [dup.primary.file, ...dup.matches.map((m) => m.file)].map((f) =>
      f.replace(/\\/g, "/"),
    );
    expect(files.some((f) => f.endsWith("helpers.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("card.tsx"))).toBe(true);
    expect(dup.similarity).toBeGreaterThanOrEqual(0.8);
  });
});
