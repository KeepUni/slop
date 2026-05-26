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
  return tmp;
}

function bigBody(name: string, salt: string): string {
  return `export function ${name}(): { x: number; y: number } {
  const a = 1 + 2;
  const b = a * 3;
  const c = b - 4;
  const d = c / 5;
  const e = d + 6;
  const f = e * 7;
  const g = f - 8;
  const h = g + 9;
  const i = h * 10;
  return { x: i + ${salt}, y: i - ${salt} };
}
`;
}

describe("duplicates: skip i18n folder pairs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-dup-i18n-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag two files in locales/ that share structure", async () => {
    mkdirSync(join(tmp, "locales"), { recursive: true });
    writeFileSync(join(tmp, "locales", "en.ts"), bigBody("en", "1"), "utf8");
    writeFileSync(join(tmp, "locales", "ru.ts"), bigBody("ru", "2"), "utf8");
    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    expect(result.issues.filter((i) => i.kind === "duplicate")).toHaveLength(0);
  });

  it("does NOT flag pairs in i18n/, translations/, messages/, langs/, intl/", async () => {
    for (const dir of ["i18n", "translations", "messages", "langs", "intl"]) {
      mkdirSync(join(tmp, dir), { recursive: true });
      writeFileSync(join(tmp, dir, "a.ts"), bigBody("a_" + dir, "1"), "utf8");
      writeFileSync(join(tmp, dir, "b.ts"), bigBody("b_" + dir, "2"), "utf8");
    }
    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    expect(result.issues.filter((i) => i.kind === "duplicate")).toHaveLength(0);
  });

  it("still flags a duplicate between a locale file and a non-locale file", async () => {
    mkdirSync(join(tmp, "locales"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "locales", "en.ts"), bigBody("en", "1"), "utf8");
    writeFileSync(join(tmp, "src", "real.ts"), bigBody("real", "2"), "utf8");
    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    expect(result.issues.filter((i) => i.kind === "duplicate").length).toBeGreaterThan(0);
  });
});

describe("empty-wrappers: skip public-name -> _internal convention", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-wrap-internal-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `superRefine -> _superRefine` (public to internal)", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `function _superRefine(fn: () => void) { fn(); }
export function superRefine(fn: () => void) {
  return _superRefine(fn);
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });

  it("does NOT flag `method -> this._method` member call", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export class X {
  _refine(fn: () => void) { fn(); }
  refine(fn: () => void) { return this._refine(fn); }
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });

  it("still flags wrappers without underscore convention", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function fetchUser(id: string) { return { id }; }
export function getUser(id: string) { return fetchUser(id); }
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const w = result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "getUser");
    expect(w).toBeDefined();
  });
});

describe("empty-catch: skip underscore-prefixed parameter", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-catch-underscore-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `catch (_)`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function f() {
  try { JSON.parse("x"); } catch (_) {}
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "empty-catch")).toHaveLength(0);
  });

  it("does NOT flag `catch (_err)`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function f() {
  try { JSON.parse("x"); } catch (_err) {}
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "empty-catch")).toHaveLength(0);
  });

  it("still flags `catch (e) {}` and bare `catch {}`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function f() {
  try { JSON.parse("x"); } catch (e) {}
  try { JSON.parse("y"); } catch {}
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(2);
  });
});
describe("empty-wrappers: NewExpression in callee chain is not a pass-through", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-newexpr-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `new Intl.NumberFormat(cfg).format(value)`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("empty-wrappers: generic type parameters preserve typing", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-generic-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag generic wrapper `<T>(x: T) => bare(x)`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export const objectValues = <T extends object>(obj: T): Array<T[keyof T]> => {
  return Object.values(obj);
};
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("empty-wrappers: typed variable alias preserves contract", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-typedvar-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `const f: SomeFn = (a, b) => bare(a, b)`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `type SqliteTableFn = (name: string, columns: unknown) => unknown;
declare function sqliteTableBase(name: string, columns: unknown): unknown;
export const sqliteTable: SqliteTableFn = (name, columns) => {
  return sqliteTableBase(name, columns);
};
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("framework conventions: Next.js App Router named exports", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-nextjs-named-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `generateStaticParams` in app/page.tsx", async () => {
    mkdirSync(join(tmp, "app", "docs"), { recursive: true });
    writeFileSync(
      join(tmp, "app", "docs", "page.tsx"),
      `declare const source: { generateParams: () => unknown[] };
export function generateStaticParams() {
  return source.generateParams();
}
export default function Page() { return null as unknown; }
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers", "code-smells"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });

  it("does NOT flag HTTP method exports in app/route.ts and route.tsx", async () => {
    mkdirSync(join(tmp, "app", "api"), { recursive: true });
    mkdirSync(join(tmp, "app", "og"), { recursive: true });
    writeFileSync(
      join(tmp, "app", "api", "route.ts"),
      `export async function GET() { return new Response("ok"); }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "app", "og", "route.tsx"),
      `export async function GET() { return new Response("img"); }\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });
});

describe("framework conventions: 'use server' directive", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-useserver-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag top-level exports in a 'use server' file", async () => {
    writeFileSync(
      join(tmp, "actions.ts"),
      `"use server";
export async function submitForm(values: Record<string, string>) {
  return { ok: true, values };
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("DOES still flag in a 'use client' file", async () => {
    writeFileSync(
      join(tmp, "client.ts"),
      `"use client";
export async function dummy() {
  return 42;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async").length).toBeGreaterThan(0);
  });
});

describe("useless-async: skip when last statement returns a CallExpression", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-barecall-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `async () => return libCall(args)`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `declare function migrate(config: unknown): Promise<void>;
export const migrateFn = async (config: unknown) => {
  return migrate(config);
};
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("does NOT flag wrapper with setup + return CallExpression", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `declare function fetchItems(items: string[]): Promise<unknown[]>;
export async function getItems(items: string[]) {
  const filtered = items.filter(Boolean);
  return fetchItems(filtered);
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("DOES still flag `async () => return null` (no Call)", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export async function getNothing() {
  return null;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async").length).toBeGreaterThan(0);
  });
});

describe("useless-async: typed variable alias and config callback skips", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-async-typed-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `const f: T = async (x) => {}`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `type Transformer = (x: unknown) => Promise<unknown>;
export const transformIcons: Transformer = async (x) => {
  return x;
};
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("does NOT flag callback in object literal passed to a call", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `declare function useForm(config: { onSubmit: (v: unknown) => Promise<void> }): void;
export function FormComp() {
  useForm({
    onSubmit: async (value) => {
      void value;
    },
  });
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("does NOT flag callback in object literal assigned to typed variable", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `interface SqliteDb {
  query: (q: string) => Promise<unknown>;
  run: (q: string) => Promise<void>;
}
export function build(): SqliteDb {
  const db: SqliteDb = {
    query: async (q) => ({ q }),
    run: async (q) => { void q; },
  };
  return db;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });
});

describe("useless-async: intentional async stub with underscore params", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-async-stub-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `async (_params) => {}`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export class Cache {
  invalidate: (params: unknown) => Promise<void> = async (_params) => {};
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });
});

describe("empty-wrappers: methods in class expressions with extends are override context", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-classexpr-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `const X = class extends Y { exposeFoo() { return this.foo(); } }`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `class Base {
  protected build(): number { return 1; }
}
export function make() {
  const Extended = class extends Base {
    buildAndExport() { return this.build(); }
  };
  return new Extended();
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("empty-wrappers: @deprecated functions are intentional aliases", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-deprecated-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag a wrapper marked @deprecated", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function provideTanStack(client: unknown): unknown[] { return [client]; }
/** @deprecated Use provideTanStack instead. */
export function provideAngularQuery(client: unknown): unknown[] {
  return provideTanStack(client);
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("empty-wrappers: methods in objects returned from a factory are API surface", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-factory-api-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `[Symbol.iterator]() { return this.keys() }` in returned object literal", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function makeIterable(): Iterable<number> {
  return {
    [Symbol.iterator]() { return this.keys(); },
    values() { return this.keys(); },
    keys(): IterableIterator<number> { return [1, 2, 3][Symbol.iterator](); },
  };
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });

  it("does NOT flag iterator-protocol methods wrapped in `as TypeName` assertion", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export function makeBackwardCompatibleSet<T>(): Set<T> {
  return {
    [Symbol.iterator]() { return this.keys(); },
    values() { return this.keys(); },
    keys(): IterableIterator<T> { return [][Symbol.iterator](); },
    has(_v: T): boolean { return false; },
    size: 0,
    add(_v: T) { return this; },
    delete(_v: T) { return false; },
    clear() {},
    forEach() {},
    entries(): IterableIterator<[T, T]> { return [][Symbol.iterator](); },
    [Symbol.toStringTag]: "Set",
  } as Set<T>;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("entry-points: package.json#files lists source directories", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-files-field-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "scaffold-tool",
        type: "module",
        main: "./dist/index.js",
        files: ["dist", "template"],
      }),
      "utf8",
    );
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("treats files in template/ as entries when listed in package.json#files", async () => {
    mkdirSync(join(tmp, "template", "src"), { recursive: true });
    writeFileSync(
      join(tmp, "template", "src", "page.tsx"),
      `export const config = { name: "starter" };\nexport function Page() { return null; }\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"] });
    const dead = result.issues.filter((i) => i.kind === "dead-code");
    expect(dead).toHaveLength(0);
  });
});

describe("test path detection: __testfixtures__ is excluded", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-testfixtures-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag exports inside __testfixtures__/ as dead", async () => {
    mkdirSync(join(tmp, "__testfixtures__"), { recursive: true });
    writeFileSync(
      join(tmp, "__testfixtures__", "input.tsx"),
      `export function never_called_but_a_fixture() { return 42 }\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp });
    const inFixtures = result.issues.filter((i) => {
      const loc = "location" in i ? i.location : "primary" in i ? i.primary : undefined;
      return loc?.file.includes("__testfixtures__");
    });
    expect(inFixtures).toHaveLength(0);
  });
});

describe("dead-code: aliased imports keep symbols alive via path-tail matching", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-alias-tail-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag a component imported via `@/` alias even without root tsconfig paths", async () => {
    mkdirSync(join(tmp, "app", "create"), { recursive: true });
    writeFileSync(
      join(tmp, "app", "create", "main-menu.tsx"),
      `export function MainMenu() { return null; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "app", "create", "page.tsx"),
      `import { MainMenu } from "@/app/create/main-menu";\nexport default function Page() { return <MainMenu />; }\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"] });
    const dead = result.issues.filter((i) => i.kind === "dead-code");
    expect(dead.find((i) => i.kind === "dead-code" && i.symbol === "MainMenu")).toBeUndefined();
  });
});

describe("entry-points: registry.json manifest lists component files (shadcn convention)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-registry-json-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "registry", type: "module" }),
      "utf8",
    );
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("treats files listed in registry.json#items[].files[].path as entries", async () => {
    mkdirSync(join(tmp, "registry", "ui"), { recursive: true });
    writeFileSync(
      join(tmp, "registry", "ui", "button.tsx"),
      `export function Button() { return null; }\nexport const buttonVariants = { default: "" };\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "registry.json"),
      JSON.stringify({
        name: "ui",
        items: [
          { name: "button", type: "registry:ui", files: [{ path: "registry/ui/button.tsx", type: "registry:ui" }] },
        ],
      }),
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"] });
    const dead = result.issues.filter((i) => i.kind === "dead-code");
    expect(dead).toHaveLength(0);
  });
});

describe("empty-wrappers: predicate-over-regex pattern is named regex check", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-regex-predicate-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `function isJSONRequest(req) { return jsonRE.test(req) }`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `const jsonRE = /\\.json$/;
export function isJSONRequest(request: string): boolean {
  return jsonRE.test(request);
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("empty-wrappers: class method chain rooted at `this` is encapsulation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-this-accessor-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `getWorkerBundle(file) { return this.bundles.get(file) }`", async () => {
    writeFileSync(
      join(tmp, "lib.ts"),
      `export class Manager {
  private bundles = new Map<string, unknown>();
  getWorkerBundle(file: string): unknown {
    return this.bundles.get(file);
  }
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper")).toHaveLength(0);
  });
});

describe("monorepo beta: workspace-package imports promote target package files to entries", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-monorepo-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "monorepo-root",
        type: "module",
        workspaces: ["packages/*"],
      }),
      "utf8",
    );
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag exports of @scope/foo as dead when imported by @scope/bar", async () => {
    mkdirSync(join(tmp, "packages", "foo", "src"), { recursive: true });
    mkdirSync(join(tmp, "packages", "bar", "src"), { recursive: true });
    writeFileSync(
      join(tmp, "packages", "foo", "package.json"),
      JSON.stringify({ name: "@scope/foo", type: "module", main: "./src/index.ts" }),
      "utf8",
    );
    writeFileSync(
      join(tmp, "packages", "foo", "src", "Button.tsx"),
      `export function Button() { return null; }\nexport const variants = { default: "" };\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "packages", "foo", "src", "index.ts"),
      `export * from "./Button";\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "packages", "bar", "package.json"),
      JSON.stringify({ name: "@scope/bar", type: "module", main: "./src/index.ts" }),
      "utf8",
    );
    writeFileSync(
      join(tmp, "packages", "bar", "src", "index.ts"),
      `import { Button } from "@scope/foo";\nexport function makeApp() { return Button(); }\n`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["dead-code"] });
    const deadInFoo = result.issues.filter(
      (i) => i.kind === "dead-code" && i.location.file.includes("packages/foo/"),
    );
    expect(deadInFoo).toHaveLength(0);
  });
});

describe("useless-async: async function returning JSX is a Server Component", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-async-jsx-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag `async function Comp() { return <Table /> }`", async () => {
    writeFileSync(
      join(tmp, "comp.tsx"),
      `declare function Table(): JSX.Element;
export async function ApiLibraries() {
  return <Table />;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });

  it("does NOT flag arrow component returning JSX", async () => {
    writeFileSync(
      join(tmp, "comp.tsx"),
      `declare function Inner(): JSX.Element;
export const Page = async () => <Inner />;
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["code-smells"] });
    expect(result.issues.filter((i) => i.kind === "useless-async")).toHaveLength(0);
  });
});
