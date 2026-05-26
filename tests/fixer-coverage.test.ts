import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";
import type { DeadCodeIssue } from "../src/detectors/types.js";
import { applyDeadCodeFixes } from "../src/fixers/dead-code.js";

function setup(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(tmp, { recursive: true });
  return tmp;
}

describe("dead-code fixer: removal semantics", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-fixer-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("removes a dead function declaration", async () => {
    writeFileSync(
      join(tmp, "index.ts"),
      `import { used } from "./mod.js";\nconsole.log(used());\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "mod.ts"),
      `export function used() { return 1; }\nexport function unused() { return 2; }\n`,
      "utf8",
    );

    const before = await scan({ rootDir: tmp, only: ["dead-code"] });
    const dead = before.issues.filter((i): i is DeadCodeIssue => i.kind === "dead-code");
    expect(dead.map((i) => i.symbol)).toContain("unused");

    await applyDeadCodeFixes(before.project, dead);

    const after = readFileSync(resolve(tmp, "mod.ts"), "utf8");
    expect(after).toContain("export function used");
    expect(after).not.toContain("export function unused");
  });

  it("removes a dead class declaration", async () => {
    writeFileSync(join(tmp, "index.ts"), `import { U } from "./mod.js";\nnew U();\n`, "utf8");
    writeFileSync(
      join(tmp, "mod.ts"),
      `export class U {}\nexport class DeadClass {}\n`,
      "utf8",
    );

    const before = await scan({ rootDir: tmp, only: ["dead-code"] });
    const dead = before.issues.filter((i): i is DeadCodeIssue => i.kind === "dead-code");
    await applyDeadCodeFixes(before.project, dead);

    const after = readFileSync(resolve(tmp, "mod.ts"), "utf8");
    expect(after).toContain("export class U");
    expect(after).not.toContain("DeadClass");
  });

  it("removes a single declaration from a multi-decl const statement", async () => {
    writeFileSync(
      join(tmp, "index.ts"),
      `import { used } from "./mod.js";\nconsole.log(used);\n`,
      "utf8",
    );
    writeFileSync(join(tmp, "mod.ts"), `export const used = 1, unused = 2;\n`, "utf8");

    const before = await scan({ rootDir: tmp, only: ["dead-code"] });
    const dead = before.issues.filter((i): i is DeadCodeIssue => i.kind === "dead-code");
    await applyDeadCodeFixes(before.project, dead);

    const after = readFileSync(resolve(tmp, "mod.ts"), "utf8");
    expect(after).toContain("used = 1");
    expect(after).not.toContain("unused");
  });

  it("reports filesChanged and removedSymbols accurately", async () => {
    writeFileSync(
      join(tmp, "index.ts"),
      `import { used } from "./mod.js";\nconsole.log(used);\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "mod.ts"),
      `export const used = 1;\nexport const dead1 = 2;\nexport const dead2 = 3;\n`,
      "utf8",
    );

    const before = await scan({ rootDir: tmp, only: ["dead-code"] });
    const dead = before.issues.filter((i): i is DeadCodeIssue => i.kind === "dead-code");
    const result = await applyDeadCodeFixes(before.project, dead);

    expect(result.filesChanged).toBe(1);
    const symbols = result.removedSymbols.map((s) => s.symbol);
    expect(symbols).toContain("dead1");
    expect(symbols).toContain("dead2");
  });

  it("second scan after fix reports zero dead-code", async () => {
    writeFileSync(
      join(tmp, "index.ts"),
      `import { used } from "./mod.js";\nconsole.log(used());\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "mod.ts"),
      `export function used() { return 1; }\nexport function unused() { return 2; }\n`,
      "utf8",
    );

    const before = await scan({ rootDir: tmp, only: ["dead-code"] });
    await applyDeadCodeFixes(
      before.project,
      before.issues.filter((i): i is DeadCodeIssue => i.kind === "dead-code"),
    );

    const after = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(after.issues.filter((i) => i.kind === "dead-code")).toHaveLength(0);
  });
});
