import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setup(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  return tmp;
}

describe("package.json#scripts: file references promoted to entries", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-scripts-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  function withScripts(scripts: Record<string, string>): void {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        main: "./entry.ts",
        scripts,
      }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
  }

  it("recognizes `node scripts/build.mjs` as entry", async () => {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    withScripts({ build: "node scripts/build.mjs" });
    writeFileSync(
      join(tmp, "scripts", "build.mjs"),
      `export function run() { return 1; }
export function helper() { return 2; }
export function deeper() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphan = result.insights.find(
      (i) => i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").endsWith("/scripts/build.mjs"),
    );
    expect(orphan).toBeUndefined();
  });

  it("recognizes `tsx ./scripts/migrate.ts --apply` as entry", async () => {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    withScripts({ migrate: "tsx ./scripts/migrate.ts --apply" });
    writeFileSync(
      join(tmp, "scripts", "migrate.ts"),
      `export function up() { return 1; }
export function down() { return 2; }
export function check() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphan = result.insights.find(
      (i) =>
        i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").endsWith("/scripts/migrate.ts"),
    );
    expect(orphan).toBeUndefined();
  });

  it("does NOT match arbitrary strings that look path-like but lack a recognized runner", async () => {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    withScripts({
      "weird-tool": "weird-tool-cli scripts/randomFile.ts",
    });
    writeFileSync(
      join(tmp, "scripts", "randomFile.ts"),
      `export function a() { return 1; }
export function b() { return 2; }
export function c() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphan = result.insights.find(
      (i) =>
        i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").endsWith("/scripts/randomFile.ts"),
    );
    expect(orphan).toBeDefined();
  });
});
