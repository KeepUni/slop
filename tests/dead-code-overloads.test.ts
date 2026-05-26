import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return tmp;
}

describe("dead-code: TypeScript function overloads", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-overloads-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("emits one issue per symbol, not one per overload signature", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function fooFn(x: number): number;
export function fooFn(x: string): string;
export function fooFn(x: number | string): number | string {
  return x;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    const findings = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") && i.symbol === "fooFn",
    );
    expect(findings).toHaveLength(1);
  });
});
