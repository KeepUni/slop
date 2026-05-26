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
  writeFileSync(join(tmp, "entry.ts"), `export const APP = 1;\n`, "utf8");
  return tmp;
}

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(target.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(target, content, "utf8");
}

describe("fixture / mock filename patterns are treated as non-production", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-fixture-mock-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("`users.fixture.ts` exports are not flagged as dead", async () => {
    write(tmp, "users.fixture.ts", `export const sampleUser = { id: "1", name: "x" };\nexport function makeUsers(n: number) { return Array.from({ length: n }, () => sampleUser); }\n`);
    const result = await scan({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).not.toContain("sampleUser");
    expect(flagged).not.toContain("makeUsers");
  });

  it("`api.mock.ts` exports are not flagged as dead", async () => {
    write(tmp, "api.mock.ts", `export const mockFetch = async () => ({ ok: true });\nexport const mockUser = { id: "1" };\n`);
    const result = await scan({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).not.toContain("mockFetch");
    expect(flagged).not.toContain("mockUser");
  });

  it("plural `*.fixtures.ts` and `*.mocks.ts` are also skipped", async () => {
    write(tmp, "data.fixtures.ts", `export const FIXTURE_USERS = [{ id: "a" }];\n`);
    write(tmp, "providers.mocks.ts", `export class MockProvider { call() { return 1; } }\n`);
    const result = await scan({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).not.toContain("FIXTURE_USERS");
    expect(flagged).not.toContain("MockProvider");
  });

  it("fixtures and mocks still count as consumers — their imports keep production symbols alive", async () => {
    write(tmp, "src/db.ts", `export function realConnect() { return 1; }\n`);
    write(tmp, "users.fixture.ts", `import { realConnect } from "./src/db.js";\nexport const ctx = realConnect();\n`);
    const result = await scan({ rootDir: tmp, verbose: true });
    const flagged = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(flagged).not.toContain("realConnect");
  });
});
