import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setup(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("entry-points: CommonJS require() chains", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-commonjs-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("follows `require('./x')` from a main-field entry through the dependency tree", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", main: "./index.js" }),
      "utf8",
    );
    writeFileSync(join(tmp, "index.js"), `module.exports = require('./lib/app');\n`, "utf8");
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(
      join(tmp, "lib", "app.js"),
      `var helper = require('./helper');\nmodule.exports = function () { return helper(); };\n`,
      "utf8",
    );
    writeFileSync(join(tmp, "lib", "helper.js"), `module.exports = function () { return 1; };\n`, "utf8");
    writeFileSync(join(tmp, "lib", "unused.js"), `module.exports = function () { return 2; };\n`, "utf8");

    const result = await scan({ rootDir: tmp });

    const reachableFiles = ["lib/app.js", "lib/helper.js"];
    for (const f of reachableFiles) {
      const found = result.insights.find(
        (i) => i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").endsWith(f),
      );
      expect(found, `${f} should not be flagged as orphan`).toBeUndefined();
    }
    const unusedOrphan = result.insights.find(
      (i) => i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").endsWith("lib/unused.js"),
    );
    expect(unusedOrphan, "lib/unused.js should be flagged as orphan").toBeDefined();
  });

  it("does not follow non-relative require()", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fixture", main: "./index.js" }),
      "utf8",
    );
    writeFileSync(join(tmp, "index.js"), `var fs = require('node:fs');\nmodule.exports = fs;\n`, "utf8");
    writeFileSync(join(tmp, "stray.js"), `module.exports = 1;\n`, "utf8");

    const result = await scan({ rootDir: tmp });
    const stray = result.insights.find(
      (i) => i.kind === "orphaned-file" && i.file.replace(/\\/g, "/").endsWith("stray.js"),
    );
    expect(stray).toBeDefined();
  });
});
