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
  return tmp;
}

describe("dead-code: real-world patterns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-dead-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a function nobody imports", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `import { keepAlive } from "./orphan";\nexport const APP = keepAlive;\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "orphan.ts"),
      `export function keepAlive() { return "live"; }
export function neverCalled() { return 42; }
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["dead-code"], verbose: true });
    expect(
      r.issues.find((i) => i.kind === "dead-code" && i.symbol === "neverCalled"),
    ).toBeDefined();
  });

  it("does not flag a const used via re-export", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export { helper } from "./lib";\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function helper() { return "ok"; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(r.issues.find((i) => "symbol" in i && i.symbol === "helper")).toBeUndefined();
  });

  it("does not flag a type used only as a type parameter elsewhere", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `import type { Item } from "./types";\nexport const list: Item[] = [];\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "types.ts"),
      `export interface Item { id: string; name: string; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(r.issues.find((i) => "symbol" in i && i.symbol === "Item")).toBeUndefined();
  });

  it("does not flag a class with decorator-based registration", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `import "./controller";\nexport const ok = true;\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "controller.ts"),
      `function Controller(path: string) { return (_target: unknown) => { void path; }; }
@Controller("/users")
export class UserController {
  list() { return []; }
}
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(r.issues.find((i) => "symbol" in i && i.symbol === "UserController")).toBeUndefined();
  });

  it("does not flag a symbol with underscore prefix even when truly unused", async () => {
    writeFileSync(join(tmp, "entry.ts"), `export const X = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "internal.ts"),
      `export function _helperInternal() { return 1; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(
      r.issues.find((i) => "symbol" in i && i.symbol === "_helperInternal"),
    ).toBeUndefined();
  });
});

describe("unused-export: real-world patterns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-unused-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags an exported helper used only inside its own file", async () => {
    writeFileSync(join(tmp, "entry.ts"), `import { use } from "./lib";\nuse();\n`, "utf8");
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function format(n: number) { return String(n); }
export function use() { return format(1); }
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["dead-code"] });
    expect(r.issues.find((i) => i.kind === "unused-export" && i.symbol === "format")).toBeDefined();
  });
});

describe("empty-wrapper: classic AI slop patterns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-wrapper-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags `getUser → fetchUser` straight rename", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `function fetchUser(id: string) { return { id }; }
export function getUser(id: string) { return fetchUser(id); }
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(r.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "getUser")).toBeDefined();
  });

  it("does not flag a wrapper that transforms arguments", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `function fetchUser(id: string) { return { id }; }
export function getUser(id: string) { return fetchUser(id.toLowerCase()); }
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(
      r.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "getUser"),
    ).toBeUndefined();
  });

  it("does not flag a wrapper that adds an awaited transformation", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `async function fetchUser(id: string) { return { id }; }
export async function getUser(id: string) {
  const user = await fetchUser(id);
  return { ...user, ready: true };
}
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(
      r.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "getUser"),
    ).toBeUndefined();
  });

  it("does not flag a method that overrides an interface", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `interface Service { run(): Promise<void>; }
declare function inner(): Promise<void>;
export class Real implements Service {
  run(): Promise<void> { return inner(); }
}
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(r.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("useless-async: AI slop patterns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-async-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags `async function getName() { return 'alice' }`", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export async function getName() { return "alice"; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(r.issues.find((i) => i.kind === "useless-async" && i.functionName === "getName")).toBeDefined();
  });

  it("does not flag async function with await", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `declare function db(): Promise<string>;
export async function getName() { return await db(); }
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(r.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("does not flag async function with explicit Promise return type", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export async function getName(): Promise<string> { return "alice"; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(r.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });
});

describe("empty-catch: AI slop patterns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-catch-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags `try {...} catch {}` (swallows all)", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export function f() { try { JSON.parse("x"); } catch {} }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["code-smells"] });
    const catches = r.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(1);
    expect((catches[0] as { swallowsAll?: boolean }).swallowsAll).toBe(true);
  });

  it("flags `catch (e) {}` (swallows with bound param)", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export function f() { try { JSON.parse("x"); } catch (e) {} }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(r.issues.filter((i) => i.kind === "empty-catch")).toHaveLength(1);
  });

  it("does not flag `catch (e) { handleError(e) }`", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `declare function handleError(e: unknown): void;
export function f() { try { JSON.parse("x"); } catch (e) { handleError(e); } }
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(r.issues.filter((i) => i.kind === "empty-catch")).toHaveLength(0);
  });
});

describe("same-shape-types: cross-file duplicates", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-shape-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags two interfaces with identical fields in different files", async () => {
    writeFileSync(join(tmp, "entry.ts"), `export const X = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "user.ts"),
      `export interface UserDTO { id: string; name: string; email: string; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "account.ts"),
      `export interface AccountDTO { id: string; name: string; email: string; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(r.issues.find((i) => i.kind === "same-shape-types")).toBeDefined();
  });

  it("does not flag interfaces with different optional flags", async () => {
    writeFileSync(join(tmp, "entry.ts"), `export const X = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "user.ts"),
      `export interface UserDTO { id: string; name?: string; email: string; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "account.ts"),
      `export interface AccountDTO { id: string; name: string; email: string; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(r.issues.filter((i) => i.kind === "same-shape-types")).toHaveLength(0);
  });

  it("does not flag interfaces with same fields but different methods", async () => {
    writeFileSync(join(tmp, "entry.ts"), `export const X = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "record.ts"),
      `export interface Record { id: string; name: string; lookup(): void; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "map.ts"),
      `export interface MapLike { id: string; name: string; getAll(): unknown[]; }\n`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(r.issues.filter((i) => i.kind === "same-shape-types")).toHaveLength(0);
  });
});

describe("useless-type-predicate", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-predicate-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags `isString(v): v is string { return typeof v === 'string' }`", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export function isString(v: unknown): v is string { return typeof v === "string"; }
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(r.issues.find((i) => i.kind === "useless-type-predicate")).toBeDefined();
  });

  it("does not flag a real predicate with multi-condition narrowing", async () => {
    writeFileSync(
      join(tmp, "entry.ts"),
      `export function isUser(v: unknown): v is { id: string } {
  return typeof v === "object" && v !== null && "id" in v;
}
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["ai-signatures"] });
    expect(r.issues.filter((i) => i.kind === "useless-type-predicate")).toHaveLength(0);
  });
});

describe("duplicates: real copy-paste vs intentional repetition", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("scenarios-duplicates-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags two near-identical functions in different unrelated files", async () => {
    writeFileSync(join(tmp, "entry.ts"), `export const X = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "userService.ts"),
      `export function createUser(name: string, email: string, role: string) {
  const id = Math.random().toString(36);
  const createdAt = new Date().toISOString();
  const meta = { id, createdAt, kind: "user" };
  return { name, email, role, ...meta };
}
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "productService.ts"),
      `export function createProduct(title: string, sku: string, category: string) {
  const id = Math.random().toString(36);
  const createdAt = new Date().toISOString();
  const meta = { id, createdAt, kind: "product" };
  return { title, sku, category, ...meta };
}
`,
      "utf8",
    );
    const r = await scan({ rootDir: tmp, only: ["duplicates"] });
    expect(r.issues.find((i) => i.kind === "duplicate")).toBeDefined();
  });

  it("does not flag two design-system style variants with the same basename", async () => {
    writeFileSync(join(tmp, "entry.ts"), `export const X = 1;\n`, "utf8");
    mkdirSync(join(tmp, "styles", "themeA"), { recursive: true });
    mkdirSync(join(tmp, "styles", "themeB"), { recursive: true });
    const body = `import { Slot } from "radix";
export function Dialog(props: { open: boolean; children: unknown }) {
  return Slot({ ...props, theme: "a" });
}
export function DialogTrigger() { return null; }
export function DialogContent() { return null; }
export function DialogTitle() { return null; }
export function DialogDescription() { return null; }
`;
    writeFileSync(join(tmp, "styles", "themeA", "dialog.tsx"), body, "utf8");
    writeFileSync(join(tmp, "styles", "themeB", "dialog.tsx"), body, "utf8");
    const r = await scan({ rootDir: tmp, only: ["duplicates"] });
    const dupCrossStyles = r.issues.filter(
      (i) =>
        i.kind === "duplicate" &&
        i.primary.file !== i.matches?.[0]?.file &&
        i.primary.file.split("/").pop() === i.matches?.[0]?.file.split("/").pop(),
    );
    expect(dupCrossStyles).toHaveLength(0);
  });
});
