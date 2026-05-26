import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setup(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module" }),
    "utf8",
  );
  return tmp;
}

function bigBody(name: string): string {
  return `export function ${name}(input: number): number {
  const a = input * 7;
  const b = a + 11;
  const c = b * b;
  const d = c - input;
  const e = d / 2;
  const f = e + a;
  const g = f - 3;
  const h = g * input;
  const i = h + 17;
  const j = i / 4;
  const k = j * 13;
  const m = k - input;
  return m * m;
}
`;
}

describe("duplicates: multi-file cluster", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-dup-cluster-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("merges the same block across 3+ files into ONE issue, not 3", async () => {
    writeFileSync(join(tmp, "a.ts"), `${bigBody("alpha")}export const _ = alpha;\n`, "utf8");
    writeFileSync(join(tmp, "b.ts"), `${bigBody("beta")}export const _ = beta;\n`, "utf8");
    writeFileSync(join(tmp, "c.ts"), `${bigBody("gamma")}export const _ = gamma;\n`, "utf8");

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups.length).toBe(1);
    if (dups[0]?.kind === "duplicate") {
      expect(dups[0].matches.length).toBeGreaterThanOrEqual(2);
      const allFiles = [dups[0].primary.file, ...dups[0].matches.map((m) => m.file)].map((f) =>
        f.replace(/\\/g, "/"),
      );
      expect(allFiles.some((f) => f.endsWith("/a.ts"))).toBe(true);
      expect(allFiles.some((f) => f.endsWith("/b.ts"))).toBe(true);
      expect(allFiles.some((f) => f.endsWith("/c.ts"))).toBe(true);
    }
  });

  it("keeps two genuinely-different dupe clusters separate", async () => {
    writeFileSync(join(tmp, "a.ts"), `${bigBody("alpha")}export const _ = alpha;\n`, "utf8");
    writeFileSync(join(tmp, "b.ts"), `${bigBody("beta")}export const _ = beta;\n`, "utf8");
    writeFileSync(
      join(tmp, "c.ts"),
      `export function rho(s: string): string {
  const a = s + "x";
  const b = a + "y";
  const c = b + "z";
  const d = c + "1";
  const e = d + "2";
  const f = e + "3";
  const g = f + "4";
  const h = g + "5";
  const i = h + "6";
  const j = i + "7";
  const k = j + "8";
  const m = k + "9";
  return m + "0";
}
export const _ = rho;
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "d.ts"),
      `export function tau(s: string): string {
  const a = s + "x";
  const b = a + "y";
  const c = b + "z";
  const d = c + "1";
  const e = d + "2";
  const f = e + "3";
  const g = f + "4";
  const h = g + "5";
  const i = h + "6";
  const j = i + "7";
  const k = j + "8";
  const m = k + "9";
  return m + "0";
}
export const _ = tau;
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups.length).toBe(2);
  });
});
