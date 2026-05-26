import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "integration");

describe("integration: vibe-coded Next.js-style app", () => {
  it("finds exactly one issue of each kind in plausible places", async () => {
    const result = await scan({ rootDir: FIXTURE_ROOT });

    const byKind = (k: string) => result.issues.filter((i) => i.kind === k);

    const dups = byKind("duplicate");
    expect(dups.length).toBe(1);
    if (dups[0]?.kind !== "duplicate") throw new Error("unreachable");
    const dupFiles = [dups[0].primary.file, ...dups[0].matches.map((m) => m.file)].map((f) =>
      f.replace(/\\/g, "/"),
    );
    expect(dupFiles.some((f) => f.endsWith("/lib/format.ts"))).toBe(true);
    expect(dupFiles.some((f) => f.endsWith("/lib/date.ts"))).toBe(true);

    const dead = byKind("dead-code").map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(dead).toContain("buildUserKey");
    expect(dead).not.toContain("Page");
    expect(dead).not.toContain("RootLayout");
    expect(dead).not.toContain("UserCard");
    expect(dead).not.toContain("getUser");
    expect(dead).not.toContain("formatTimestamp");
    expect(dead).not.toContain("toIsoLocal");
    expect(dead).not.toContain("_formats");

    const wrappers = byKind("empty-wrapper").map((i) =>
      i.kind === "empty-wrapper" ? i.outerName : "",
    );
    expect(wrappers).toContain("getUser");
    expect(wrappers).not.toContain("Page");
    expect(wrappers).not.toContain("RootLayout");
  });
});
