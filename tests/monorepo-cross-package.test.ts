import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCrossWorkspaceImports, discoverWorkspacePackages } from "../src/core/monorepo.js";
import { scanMonorepo } from "../src/core/scanner.js";

function makeRoot(): string {
  const tmp = mkdtempSync(join(tmpdir(), "slp-cross-pkg-"));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "utf8",
  );
  return tmp;
}

function addPackage(
  root: string,
  name: string,
  files: Record<string, string>,
  pkg: Record<string, unknown> = {},
): void {
  const dir = join(root, "packages", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@scope/${name}`,
      type: "module",
      main: "./src/index.ts",
      ...pkg,
    }),
    "utf8",
  );
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(target.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

function symbolsFlagged(result: { issues: Array<{ kind: string }> }, ...names: string[]): string[] {
  return result.issues
    .filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        names.includes((i as { symbol: string }).symbol),
    )
    .map((i) => (i as { symbol: string }).symbol);
}

describe("collectCrossWorkspaceImports: per-symbol precision", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeRoot();
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("named imports populate consumed-symbol set with original names", () => {
    addPackage(tmp, "a", { "src/index.ts": `export const foo = 1;\nexport const bar = 2;\n` });
    addPackage(tmp, "b", { "src/index.ts": `import { foo, bar as renamed } from "@scope/a";\nexport const X = foo + renamed;\n` });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    const set = refs.get(aDir)!;
    expect(set.has("foo")).toBe(true);
    expect(set.has("bar")).toBe(true);
  });

  it("default import resolves the target package's `export default function Name`", () => {
    addPackage(tmp, "a", { "src/index.ts": `export default function PrimaryButton() { return 1; }\n` });
    addPackage(tmp, "b", { "src/index.ts": `import LocalName from "@scope/a";\nexport const X = LocalName();\n` });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    const set = refs.get(aDir)!;
    expect(set.has("PrimaryButton")).toBe(true);
    expect(set.has("LocalName")).toBe(false);
  });

  it("default import resolves `export default class Name`", () => {
    addPackage(tmp, "a", { "src/index.ts": `export default class Logger { log() {} }\n` });
    addPackage(tmp, "b", { "src/index.ts": `import L from "@scope/a";\nexport const X = new L();\n` });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    expect(refs.get(aDir)!.has("Logger")).toBe(true);
  });

  it("default import resolves `export default Ident` (identifier form)", () => {
    addPackage(tmp, "a", {
      "src/index.ts": `function helper() { return 1; }\nexport default helper;\n`,
    });
    addPackage(tmp, "b", { "src/index.ts": `import h from "@scope/a";\nexport const X = h();\n` });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    expect(refs.get(aDir)!.has("helper")).toBe(true);
  });

  it("default import of an anonymous default falls back to CONSUMED_ALL", () => {
    addPackage(tmp, "a", { "src/index.ts": `export default () => 1;\n` });
    addPackage(tmp, "b", { "src/index.ts": `import f from "@scope/a";\nexport const X = f();\n` });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    expect(refs.get(aDir)!.has("*")).toBe(true);
  });

  it("namespace import scans consumer for `X.member` accesses (per-symbol)", () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const used = 1;\nexport const alsoUsed = 2;\nexport const notUsed = 3;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import * as A from "@scope/a";\nexport const X = A.used + A.alsoUsed;\n`,
    });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    const set = refs.get(aDir)!;
    expect(set.has("used")).toBe(true);
    expect(set.has("alsoUsed")).toBe(true);
    expect(set.has("notUsed")).toBe(false);
    expect(set.has("*")).toBe(false);
  });

  it("namespace import with no concrete member access falls back to CONSUMED_ALL", () => {
    addPackage(tmp, "a", { "src/index.ts": `export const foo = 1;\n` });
    addPackage(tmp, "b", {
      "src/index.ts": `import * as A from "@scope/a";\nconst dynamic = "foo";\nexport const X = (A as unknown as Record<string, number>)[dynamic];\n`,
    });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    expect(refs.get(aDir)!.has("*")).toBe(true);
  });

  it("`export * from '@scope/x'` triggers CONSUMED_ALL on the source", () => {
    addPackage(tmp, "a", { "src/index.ts": `export const a1 = 1;\nexport const a2 = 2;\n` });
    addPackage(tmp, "b", { "src/index.ts": `export * from "@scope/a";\n` });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    expect(refs.get(aDir)!.has("*")).toBe(true);
  });

  it("imports that resolve back into the importer's own package are ignored", () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const foo = 1;\nimport { foo as f } from "@scope/a";\nexport const X = f;\n`,
    });
    const pkgs = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, pkgs);
    const aDir = pkgs.find((p) => p.name === "@scope/a")!.dir;
    expect(refs.get(aDir)!.has("foo")).toBe(false);
  });
});

describe("scanMonorepo: real dead-code is flagged at per-symbol granularity", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeRoot();
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("namespace import: consumer's `A.foo` access populates externallyConsumed with `foo` (and nothing more)", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const used = 1;\nexport const alsoUsed = 2;\nexport const notUsed = 3;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import * as A from "@scope/a";\nexport const X = A.used + A.alsoUsed;\n`,
    });
    const packages = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, packages);
    const aDir = packages.find((p) => p.name === "@scope/a")!.dir;
    const set = refs.get(aDir)!;
    expect(set.has("used")).toBe(true);
    expect(set.has("alsoUsed")).toBe(true);
    expect(set.has("notUsed")).toBe(false);
  });

  it("default import: cross-package pre-pass writes the resolved default-export name into externallyConsumed", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export default function ResolvedDefault() { return 1; }\nexport function NamedSibling() { return 2; }\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import LocalAlias from "@scope/a";\nexport const X = LocalAlias();\n`,
    });
    const packages = discoverWorkspacePackages(tmp);
    const refs = collectCrossWorkspaceImports(tmp, packages);
    const aDir = packages.find((p) => p.name === "@scope/a")!.dir;
    const set = refs.get(aDir)!;
    expect(set.has("ResolvedDefault")).toBe(true);
    expect(set.has("LocalAlias")).toBe(false);
    expect(set.has("NamedSibling")).toBe(false);
  });

  it("non-entry file's exports are flagged dead when no cross-package consumer claims them", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `import { wired } from "./wired";\nexport { wired };\n`,
      "src/wired.ts": `export function wired() { return 1; }\nexport function Orphan() { return 2; }\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { wired } from "@scope/a";\nexport const X = wired();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "wired", "Orphan");
    expect(flagged).toContain("Orphan");
    expect(flagged).not.toContain("wired");
  });

  it("`export * from` chain: A re-exports B; consumer imports from A — only B's named-imported symbols stay alive at first hop, full consume at re-export", async () => {
    addPackage(tmp, "core", {
      "src/index.ts": `export const apple = 1;\nexport const banana = 2;\nexport const orphanFruit = 3;\n`,
    });
    addPackage(tmp, "barrel", {
      "src/index.ts": `export * from "@scope/core";\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { apple } from "@scope/barrel";\nexport const X = apple;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "apple", "banana", "orphanFruit");
    expect(flagged).toHaveLength(0);
  });

  it("dead-code in a workspace package's NON-entry file is still flagged", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export { live } from "./live";\n`,
      "src/live.ts": `export const live = 1;\n`,
      "src/orphan.ts": `export const orphaned = 2;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { live } from "@scope/a";\nexport const X = live;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "live", "orphaned");
    expect(flagged).toContain("orphaned");
    expect(flagged).not.toContain("live");
  });

  it("subpath import `@scope/a/sub` keeps the deep file's symbols alive via the dead-code alias-tail fallback", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const root = 1;\n`,
      "src/sub.ts": `export const innerOne = 2;\nexport const innerTwo = 3;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { innerOne } from "@scope/a/sub";\nexport const X = innerOne;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "innerOne", "innerTwo");
    expect(flagged).not.toContain("innerOne");
  });

  it("per-package tsconfig#paths resolves correctly", async () => {
    addPackage(
      tmp,
      "ui",
      {
        "src/index.ts": `import { Card } from "@/components/card";\nexport const X = Card;\n`,
        "src/components/card.tsx": `export function Card() { return null; }\n`,
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
        }),
      },
    );
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(symbolsFlagged(result, "Card")).not.toContain("Card");
  });

  it("renamed named import `import { foo as bar }` correctly resolves the original `foo`", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `import { realName } from "./impl";\nexport { realName };\n`,
      "src/impl.ts": `export const realName = 1;\nexport const orphan = 2;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { realName as aliased } from "@scope/a";\nexport const X = aliased;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "realName", "orphan");
    expect(flagged).toContain("orphan");
    expect(flagged).not.toContain("realName");
  });

  it("`import type { X }` is still tracked as a consumer", async () => {
    addPackage(tmp, "types", {
      "src/index.ts": `export type { User } from "./user";\nexport type { Unused } from "./user";\n`,
      "src/user.ts": `export interface User { id: string }\nexport interface Unused { x: number }\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import type { User } from "@scope/types";\nexport const x: User = { id: "1" };\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "User", "Unused");
    expect(flagged).not.toContain("User");
  });

  it("mixed default + named import in one statement: `import D, { x } from '@scope/a'`", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `import { namedThing } from "./impl";\nexport { namedThing };\nexport default function DefaultThing() { return 3; }\n`,
      "src/impl.ts": `export const namedThing = 1;\n`,
      "src/orphan.ts": `export const orphanThing = 2;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import DefaultThing, { namedThing } from "@scope/a";\nexport const X = DefaultThing() + namedThing;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "namedThing", "orphanThing", "DefaultThing");
    expect(flagged).toContain("orphanThing");
    expect(flagged).not.toContain("namedThing");
    expect(flagged).not.toContain("DefaultThing");
  });

  it("three-package chain: app → barrel → core, with selective named re-exports", async () => {
    addPackage(tmp, "core", {
      "src/index.ts": `import { usedThroughChain } from "./impl";\nexport { usedThroughChain };\n`,
      "src/impl.ts": `export const usedThroughChain = 1;\n`,
      "src/orphan.ts": `export const orphanInCore = 2;\n`,
    });
    addPackage(tmp, "barrel", {
      "src/index.ts": `export { usedThroughChain } from "@scope/core";\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { usedThroughChain } from "@scope/barrel";\nexport const X = usedThroughChain;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "usedThroughChain", "orphanInCore");
    expect(flagged).toContain("orphanInCore");
    expect(flagged).not.toContain("usedThroughChain");
  });

  it("circular package dependency does not loop or false-positive", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `import { fromB } from "@scope/b";\nexport const fromA = fromB + 1;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { fromA } from "@scope/a";\nexport const fromB = 1;\nexport { fromA as alsoFromA };\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it("pnpm workspace yaml is detected (not just package.json#workspaces)", async () => {
    rmSync(join(tmp, "package.json"));
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root" }), "utf8");
    writeFileSync(join(tmp, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`, "utf8");
    addPackage(tmp, "lib", {
      "src/index.ts": `import { live } from "./impl";\nexport { live };\n`,
      "src/impl.ts": `export const live = 1;\nexport const dead = 2;\n`,
    });
    addPackage(tmp, "app", { "src/index.ts": `import { live } from "@scope/lib";\nexport const X = live;\n` });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(symbolsFlagged(result, "dead")).toContain("dead");
    expect(symbolsFlagged(result, "live")).not.toContain("live");
  });

  it("yarn workspaces object form `{ packages: [...] }` is detected", async () => {
    rmSync(join(tmp, "package.json"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"] } }),
      "utf8",
    );
    addPackage(tmp, "lib", {
      "src/index.ts": `import { live } from "./impl";\nexport { live };\n`,
      "src/impl.ts": `export const live = 1;\nexport const dead = 2;\n`,
    });
    addPackage(tmp, "app", { "src/index.ts": `import { live } from "@scope/lib";\nexport const X = live;\n` });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(symbolsFlagged(result, "dead")).toContain("dead");
  });

  it("symbol used cross-package but ALSO dead-locally is correctly kept alive", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export { sharedHelper } from "./helper";\n`,
      "src/helper.ts": `export function sharedHelper() { return 1; }\n`,
    });
    addPackage(tmp, "consumer", {
      "src/index.ts": `import { sharedHelper } from "@scope/lib";\nexport const X = sharedHelper();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(symbolsFlagged(result, "sharedHelper")).not.toContain("sharedHelper");
  });

  it("scanMonorepo aggregates issues from ALL packages, not just one", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export { used } from "./live";\n`,
      "src/live.ts": `export const used = 1;\n`,
      "src/orphan-a.ts": `export const deadInA = 2;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { used } from "@scope/a";\nexport const X = used;\n`,
      "src/orphan-b.ts": `export const deadInB = 3;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = symbolsFlagged(result, "deadInA", "deadInB");
    expect(flagged).toContain("deadInA");
    expect(flagged).toContain("deadInB");
  });

  it("non-monorepo input to scanMonorepo falls back to single-project scan", async () => {
    rmSync(join(tmp, "package.json"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "single", type: "module", main: "./entry.ts" }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = 1;\n`, "utf8");
    const result = await scanMonorepo({ rootDir: tmp });
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});

describe("scanMonorepo: smell detectors fire per-package", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeRoot();
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("empty-wrapper inside a workspace package is still detected", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export { wrapped } from "./wrap";\n`,
      "src/wrap.ts": `function realImpl(s: string) { return s.toUpperCase(); }\nexport function wrapped(s: string) { return realImpl(s); }\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { wrapped } from "@scope/lib";\nexport const X = wrapped("hi");\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(result.issues.filter((i) => i.kind === "empty-wrapper").length).toBeGreaterThan(0);
  });

  it("useless-async inside a workspace package is still detected", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export async function pointlessAsync(x: number) { return x + 1; }\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { pointlessAsync } from "@scope/lib";\nexport const X = pointlessAsync(1);\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(result.issues.filter((i) => i.kind === "useless-async").length).toBeGreaterThan(0);
  });

  it("empty-catch inside a workspace package is still detected", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export function bad() {\n  try { JSON.parse("x"); } catch {}\n  return 1;\n}\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { bad } from "@scope/lib";\nexport const X = bad();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(result.issues.filter((i) => i.kind === "empty-catch").length).toBeGreaterThan(0);
  });
});
