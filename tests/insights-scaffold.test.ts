import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setup(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", main: "./entry.ts" }),
    "utf8",
  );
  writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
  mkdirSync(join(tmp, "components", "ui"), { recursive: true });
  return tmp;
}

describe("insight: scaffold-folder (shadcn-ui)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-scaffold-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("rolls 3+ unused components/ui/* into one scaffold-folder insight", async () => {
    for (const name of ["button", "card", "dialog", "tooltip"]) {
      writeFileSync(
        join(tmp, "components", "ui", `${name}.tsx`),
        `export function ${capitalize(name)}() { return null }\n`,
        "utf8",
      );
    }
    const result = await scan({ rootDir: tmp });
    const scaffold = result.insights.find((i) => i.kind === "scaffold-folder");
    expect(scaffold).toBeDefined();
    if (scaffold?.kind === "scaffold-folder") {
      expect(scaffold.files.length).toBe(4);
      expect(scaffold.scaffold).toBe("shadcn-ui");
      expect(scaffold.folder.replace(/\\/g, "/")).toMatch(/components\/ui$/);
    }
    const orphansInUi = result.insights.filter(
      (i) => i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").includes("components/ui"),
    );
    expect(orphansInUi).toHaveLength(0);
  });

  it("falls back to orphaned-file when fewer than 3 components/ui/* are unused", async () => {
    writeFileSync(
      join(tmp, "components", "ui", "button.tsx"),
      `export function Button() { return null }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "components", "ui", "card.tsx"),
      `export function Card() { return null }\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp });
    expect(result.insights.find((i) => i.kind === "scaffold-folder")).toBeUndefined();
    const orphans = result.insights.filter(
      (i) => i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").includes("components/ui"),
    );
    expect(orphans.length).toBe(2);
  });

  it("does not collapse a non-scaffold folder", async () => {
    mkdirSync(join(tmp, "lib", "helpers"), { recursive: true });
    for (const name of ["a", "b", "c", "d"]) {
      writeFileSync(
        join(tmp, "lib", "helpers", `${name}.ts`),
        `export function fn${name}() { return ${JSON.stringify(name)} }\n`,
        "utf8",
      );
    }
    const result = await scan({ rootDir: tmp });
    expect(result.insights.find((i) => i.kind === "scaffold-folder")).toBeUndefined();
  });
});

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
