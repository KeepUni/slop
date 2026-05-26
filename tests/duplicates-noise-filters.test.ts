import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

describe("duplicates: import statements are excluded from matching", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-dup-imports-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module" }),
      "utf8",
    );
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag two files sharing only import boilerplate", async () => {
    const imports = [
      `import type { Metadata } from "next";`,
      `import { notFound } from "next/navigation";`,
      `import { getThing } from "../lib/api.js";`,
      `import { Prose, Card, Button, Header, Footer, Sidebar, Spinner } from "../components/ui.js";`,
      `import { z, a, b, c, d, e, f, g, h, i, j } from "../lib/letters.js";`,
    ].join("\n");

    writeFileSync(
      join(tmp, "alpha.ts"),
      `${imports}\nexport function alpha() { return "alpha-specific-thing"; }\nexport const _all = { alpha };\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "beta.ts"),
      `${imports}\nexport function beta() { return 42 + 7; }\nexport const _all = { beta };\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    expect(result.issues.filter((i) => i.kind === "duplicate")).toHaveLength(0);
  });

  it("STILL flags real body duplication when imports are identical", async () => {
    const imports = `import type { Foo } from "./types.js";\n`;
    const body = `
export function compute(input: number): number {
  const a = input * 2;
  const b = a + 1;
  const c = b * b;
  const d = c - input;
  const e = d / 2;
  const f = e + a;
  const g = f - 3;
  const h = g * input;
  const i = h + 7;
  const j = i / 4;
  const k = j * 11;
  const m = k - input;
  return m * m;
}
export const _keep = compute;
`;

    writeFileSync(join(tmp, "alpha.ts"), imports + body, "utf8");
    writeFileSync(
      join(tmp, "beta.ts"),
      imports +
        body.replace("compute", "calculate").replace("_keep = compute", "_keep = calculate"),
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups.length).toBeGreaterThan(0);
  });
});

describe("duplicates: same-file sibling repetition is suppressed", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-dup-siblings-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", type: "module" }),
      "utf8",
    );
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag tight sibling repetition inside one block", async () => {
    mkdirSync(join(tmp, "components"), { recursive: true });
    writeFileSync(
      join(tmp, "components", "skeleton.tsx"),
      `export function Skeleton() {\n` +
        `  return (\n` +
        `    <div>\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `      <div className="skeleton-row item-a" />\n` +
        `    </div>\n` +
        `  );\n` +
        `}\n` +
        `export const _keep = Skeleton;\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    const sameFileSiblings = dups.filter(
      (i) => i.kind === "duplicate" && i.matches.some((m) => m.file === i.primary.file),
    );
    expect(sameFileSiblings).toHaveLength(0);
  });

  it("STILL flags real intra-file duplication separated by enough distance", async () => {
    const fn = (name: string) => `export function ${name}(date: Date): string {
  const yr = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const dy = String(date.getDate()).padStart(2, "0");
  const hr = String(date.getHours()).padStart(2, "0");
  const mn = String(date.getMinutes()).padStart(2, "0");
  const sc = String(date.getSeconds()).padStart(2, "0");
  return \`\${yr}-\${mo}-\${dy}T\${hr}:\${mn}:\${sc}\`;
}\n`;
    const spacer = `\nexport async function unrelated(input: { name: string; id: number }): Promise<string> {
  if (!input) throw new Error("no input");
  if (input.name.length === 0) throw new Error("empty");
  const computed = input.id * 2 + 1;
  const transformed = input.name.toUpperCase().split("").reverse().join("");
  return \`\${computed}:\${transformed}\`;
}\n`;

    writeFileSync(
      join(tmp, "dates.ts"),
      `${fn("formatA")}${spacer}${fn("formatB")}\nexport const _keep = { formatA, formatB };\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups.length).toBeGreaterThan(0);
  });
});
