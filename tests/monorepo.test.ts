import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";
import { isMonorepo } from "../src/core/monorepo.js";

function setup(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("monorepo: detection signals", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-monorepo-detect-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("detects npm/yarn workspaces (array form)", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "utf8",
    );
    expect(isMonorepo(tmp)).toBe(true);
  });

  it("detects yarn workspaces (object form with packages key)", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"] } }),
      "utf8",
    );
    expect(isMonorepo(tmp)).toBe(true);
  });

  it("detects pnpm-workspace.yaml", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root" }),
      "utf8",
    );
    writeFileSync(join(tmp, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
    expect(isMonorepo(tmp)).toBe(true);
  });

  it("does NOT detect single-package repos", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "regular", main: "./index.ts" }),
      "utf8",
    );
    expect(isMonorepo(tmp)).toBe(false);
  });

  it("does NOT detect when package.json is malformed", () => {
    writeFileSync(join(tmp, "package.json"), "{ not valid json", "utf8");
    expect(isMonorepo(tmp)).toBe(false);
  });
});

describe("monorepo: orphaned-file insight is suppressed", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-monorepo-orphan-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("in a workspace root, orphaned-file insight is empty even when files would qualify", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"], main: "./entry.ts" }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "lonely.ts"),
      `export function alpha() { return 1; }
export function beta() { return 2; }
export function gamma() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("in a regular (non-workspace) repo, orphaned-file still fires", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "regular", type: "module", main: "./entry.ts" }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    writeFileSync(
      join(tmp, "lonely.ts"),
      `export function alpha() { return 1; }
export function beta() { return 2; }
export function gamma() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans.length).toBeGreaterThan(0);
  });
});

describe("monorepo: sub-package.json entry walking", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-monorepo-subentry-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("recognizes entry-point fields from sub-package package.json", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root" }),
      "utf8",
    );
    mkdirSync(join(tmp, "packages", "lib"), { recursive: true });
    writeFileSync(
      join(tmp, "packages", "lib", "package.json"),
      JSON.stringify({ name: "@x/lib", main: "./entry.ts" }),
      "utf8",
    );
    writeFileSync(
      join(tmp, "packages", "lib", "entry.ts"),
      `export function SubLibFn(): number { return 42; }\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const flagged = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.symbol === "SubLibFn",
    );
    expect(flagged).toBeUndefined();
  });
});
