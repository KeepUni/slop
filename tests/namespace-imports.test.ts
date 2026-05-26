import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setupFixture(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", main: "./entry.ts" }),
    "utf8",
  );
  return tmp;
}

describe("namespace import: promotes target to entry-point", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-namespace-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag exports of a namespace-imported module as dead", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `import * as Tags from "./tags.js";
console.log(Tags.foo(), Tags.bar());
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "tags.ts"),
      `export function foo() { return 1; }
export function bar() { return 2; }
export function baz() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const deadIn = (sym: string) =>
      result.issues.find(
        (i) =>
          (i.kind === "dead-code" || i.kind === "unused-export") &&
          i.symbol === sym,
      );
    expect(deadIn("foo")).toBeUndefined();
    expect(deadIn("bar")).toBeUndefined();
    expect(deadIn("baz")).toBeUndefined();
  });

  it("still flags a non-namespace-imported module's unused exports", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `import { foo } from "./tags.js";\nconsole.log(foo());\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "tags.ts"),
      `export function foo() { return 1; }
export function unused() { return 2; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const unused = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.symbol === "unused",
    );
    expect(unused).toBeDefined();
  });
});
