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

describe("empty-wrappers: exemption patterns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-wrappers-fp-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag a zero-arg schema factory (Zod-style fluent chain)", async () => {
    writeFileSync(
      join(tmp, "schema.ts"),
      `const z = { object: (_o: object) => ({ optional: () => ({}), partial: () => ({}) }) };
export const FooSchema = () => z.object({ a: 1 }).optional();
export const BarSchema = () => z.object({ b: 2 }).partial();
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });

  it("does NOT flag a function whose return type is a type predicate", async () => {
    writeFileSync(
      join(tmp, "guards.ts"),
      `const variants = new Set(["a", "b"]);
export function isAsideVariant(s: string): s is "a" | "b" {
  return variants.has(s);
}
const SITES = ["x", "y"] as const;
type Site = (typeof SITES)[number];
export const isSite = (value: string): value is Site =>
  (SITES as readonly string[]).includes(value);
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });

  it("still flags a real one-arg pass-through wrapper", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function fetchUser(id: string) { return { id }; }
export function getUser(id: string) { return fetchUser(id); }
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues.filter((i) => i.kind === "empty-wrapper");
    expect(wrappers).toHaveLength(1);
    if (wrappers[0].kind === "empty-wrapper") expect(wrappers[0].outerName).toBe("getUser");
  });
});
