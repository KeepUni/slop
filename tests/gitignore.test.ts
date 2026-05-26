import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFiles } from "../src/core/files.js";

describe("file discovery respects .gitignore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-gitignore-"));
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "vendor"), { recursive: true });
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, "vendor", "lib.ts"), "export const y = 2;\n");
    writeFileSync(join(tmp, ".gitignore"), "vendor/\n");
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("excludes paths listed in .gitignore", async () => {
    const files = await discoverFiles({ rootDir: tmp });
    const rel = files.map((f) => f.replace(/\\/g, "/"));
    expect(rel.some((f) => f.endsWith("/src/app.ts"))).toBe(true);
    expect(rel.some((f) => f.endsWith("/vendor/lib.ts"))).toBe(false);
  });
});
