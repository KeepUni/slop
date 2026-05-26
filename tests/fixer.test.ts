import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";
import { applyDeadCodeFixes } from "../src/fixers/dead-code.js";
import type { DeadCodeIssue } from "../src/detectors/types.js";

describe("dead-code --fix", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-"));
    mkdirSync(tmp, { recursive: true });
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
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("removes dead exports and leaves used ones intact", async () => {
    const before = await scan({ rootDir: tmp, only: ["dead-code"] });
    const deadIssues = before.issues.filter((i): i is DeadCodeIssue => i.kind === "dead-code");
    expect(deadIssues.map((i) => i.symbol)).toContain("unused");

    await applyDeadCodeFixes(before.project, deadIssues);

    const modAfter = readFileSync(resolve(tmp, "mod.ts"), "utf8");
    expect(modAfter).toContain("export function used");
    expect(modAfter).not.toContain("export function unused");

    const after = await scan({ rootDir: tmp, only: ["dead-code"] });
    const stillDead = after.issues.filter((i) => i.kind === "dead-code");
    expect(stillDead).toHaveLength(0);
  });
});
