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

describe("same-shape-types: version-suffixed pairs are not flagged", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-versioned-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("`UserV1` + `UserV2` with identical fields are recognized as API versions", async () => {
    write(
      tmp,
      "v1/user.ts",
      `export interface UserV1 { id: string; name: string; email: string }\nexport const _u1: UserV1 = { id: "1", name: "a", email: "b" };\n`,
    );
    write(
      tmp,
      "v2/user.ts",
      `export interface UserV2 { id: string; name: string; email: string }\nexport const _u2: UserV2 = { id: "1", name: "a", email: "b" };\n`,
    );
    const result = await scan({ rootDir: tmp });
    const shape = result.issues.find(
      (i) => i.kind === "same-shape-types" && (i.primaryName === "UserV1" || i.matchNames.includes("UserV2")),
    );
    expect(shape).toBeUndefined();
  });

  it("`OrderVersion1` + `OrderVersion2` long-form version suffix is recognized", async () => {
    write(
      tmp,
      "schemas.ts",
      `export interface OrderVersion1 { id: number; total: number; status: string }
export interface OrderVersion2 { id: number; total: number; status: string }
export const _o1: OrderVersion1 = { id: 1, total: 2, status: "x" };
export const _o2: OrderVersion2 = { id: 1, total: 2, status: "x" };
`,
    );
    const result = await scan({ rootDir: tmp });
    expect(result.issues.find((i) => i.kind === "same-shape-types")).toBeUndefined();
  });

  it("`User_v1` + `User_v2` underscore-version suffix is recognized", async () => {
    write(
      tmp,
      "schemas.ts",
      `export interface User_v1 { id: string; name: string; email: string }
export interface User_v2 { id: string; name: string; email: string }
export const _x: User_v1 = { id: "1", name: "a", email: "b" };
export const _y: User_v2 = { id: "1", name: "a", email: "b" };
`,
    );
    const result = await scan({ rootDir: tmp });
    expect(result.issues.find((i) => i.kind === "same-shape-types")).toBeUndefined();
  });

  it("non-versioned identically-named types still surface as same-shape", async () => {
    write(
      tmp,
      "schemas.ts",
      `export interface ProductDto { id: string; price: number; sku: string }
export interface InventoryRow { id: string; price: number; sku: string }
export const _p: ProductDto = { id: "1", price: 1, sku: "x" };
export const _i: InventoryRow = { id: "1", price: 1, sku: "x" };
`,
    );
    const result = await scan({ rootDir: tmp });
    const shape = result.issues.find((i) => i.kind === "same-shape-types");
    expect(shape).toBeDefined();
  });

  it("a versioned pair plus a separate non-versioned pair still surfaces the non-versioned pair", async () => {
    write(
      tmp,
      "schemas.ts",
      `export interface OrderV1 { id: string; total: number; status: string }
export interface OrderV2 { id: string; total: number; status: string }
export interface PaymentRecord { id: string; total: number; status: string }
export interface RefundEvent { id: string; total: number; status: string }
export const _o1: OrderV1 = { id: "1", total: 1, status: "ok" };
export const _o2: OrderV2 = { id: "1", total: 1, status: "ok" };
export const _p: PaymentRecord = { id: "1", total: 1, status: "ok" };
export const _r: RefundEvent = { id: "1", total: 1, status: "ok" };
`,
    );
    const result = await scan({ rootDir: tmp });
    const shape = result.issues.find((i) => i.kind === "same-shape-types");
    expect(shape).toBeDefined();
    if (shape && shape.kind === "same-shape-types") {
      const all = [shape.primaryName, ...shape.matchNames];
      expect(all).toContain("PaymentRecord");
      expect(all).toContain("RefundEvent");
      expect(all).not.toContain("OrderV1");
      expect(all).not.toContain("OrderV2");
    }
  });
});
