import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanMonorepo } from "../src/core/scanner.js";

function makeRoot(): string {
  const tmp = mkdtempSync(join(tmpdir(), "slp-per-package-"));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "monorepo-root", workspaces: ["packages/*"] }),
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

describe("scanMonorepo: per-package architecture", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeRoot();
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("scans each workspace package independently and aggregates results", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export { run } from "./run";\n`,
      "src/run.ts": `export function run() { return 1; }\n`,
      "src/dead-in-a.ts": `export function deadInA() { return 2; }\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { run } from "@scope/a";\nexport const x = run();\n`,
      "src/dead-in-b.ts": `export function deadInB() { return 3; }\n`,
    });

    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const deadSymbols = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));
    expect(deadSymbols).toContain("deadInA");
    expect(deadSymbols).toContain("deadInB");
  });

  it("cross-package consumed symbols are NOT reported as dead in their declaring package", async () => {
    addPackage(tmp, "core", {
      "src/index.ts": `export { Button } from "./Button";\n`,
      "src/Button.tsx": `export function Button() { return null; }\nexport const variants = { default: "" };\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { Button, variants } from "@scope/core";\nexport const X = Button;\nexport const V = variants;\n`,
    });

    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        (i.symbol === "Button" || i.symbol === "variants"),
    );
    expect(flagged).toHaveLength(0);
  });

  it("resolves per-package tsconfig#paths via the alias-tail fallback", async () => {
    addPackage(tmp, "ui", {
      "src/index.ts": `import { Card } from "@/components/card";\nexport const X = Card;\n`,
      "src/components/card.tsx": `export function Card() { return null; }\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
    });

    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        i.symbol === "Card",
    );
    expect(flagged).toBeUndefined();
  });

  it("each package's smell detectors still fire (empty-wrapper inside @scope/lib)", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export { format } from "./format";\n`,
      "src/format.ts": `function realFormat(s: string) { return s.toUpperCase(); }
export function format(s: string) { return realFormat(s); }
`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { format } from "@scope/lib";\nexport const Y = format("hi");\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const wrappers = result.issues.filter((i) => i.kind === "empty-wrapper");
    expect(wrappers.length).toBeGreaterThan(0);
  });

  it("handles pnpm-workspace.yaml monorepos", async () => {
    rmSync(join(tmp, "package.json"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "monorepo-root" }),
      "utf8",
    );
    writeFileSync(join(tmp, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`, "utf8");
    addPackage(tmp, "lib", {
      "src/index.ts": `export const live = 1;\n`,
      "src/dead.ts": `export const dead = 2;\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { live } from "@scope/lib";\nexport const X = live;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const dead = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        i.symbol === "dead",
    );
    expect(dead).toBeDefined();
  });

  it("subpath imports `@scope/a/sub` keep deep file symbols alive", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const root = 1;\n`,
      "src/sub.ts": `export const inner = 2;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { inner } from "@scope/a/sub";\nexport const X = inner;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        i.symbol === "inner",
    );
    expect(flagged).toBeUndefined();
  });

  it("namespace import `import * as X from '@scope/a'` keeps all of @scope/a's exports alive", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const one = 1;\nexport const two = 2;\nexport function three() { return 3; }\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import * as A from "@scope/a";\nexport const X = A.one + A.two + A.three();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        ["one", "two", "three"].includes(i.symbol),
    );
    expect(flagged).toHaveLength(0);
  });

  it("default import `import X from '@scope/a'` keeps the default export alive", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export default function Renderer() { return 1; }\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import Renderer from "@scope/a";\nexport const X = Renderer();\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        i.symbol === "Renderer",
    );
    expect(flagged).toHaveLength(0);
  });

  it("`export * from '@scope/a'` re-export keeps all of @scope/a's symbols alive", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const apple = 1;\nexport const banana = 2;\nexport const cherry = 3;\n`,
    });
    addPackage(tmp, "barrel", {
      "src/index.ts": `export * from "@scope/a";\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { apple } from "@scope/barrel";\nexport const X = apple;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const flagged = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "symbol" in i &&
        ["apple", "banana", "cherry"].includes(i.symbol),
    );
    expect(flagged).toHaveLength(0);
  });

  it("real dead-code in a non-entry file inside a workspace package IS still flagged", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export { used } from "./live";\n`,
      "src/live.ts": `export const used = 1;\n`,
      "src/orphan.ts": `export const trulyDead = 2;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { used } from "@scope/a";\nexport const X = used;\n`,
    });
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    const deadOrUnused = result.issues
      .filter((i) => (i.kind === "dead-code" || i.kind === "unused-export") && "symbol" in i)
      .map((i) => ("symbol" in i ? i.symbol : ""));
    expect(deadOrUnused).toContain("trulyDead");
    expect(deadOrUnused).not.toContain("used");
  });

  it("non-monorepo root falls back to single scan", async () => {
    rmSync(join(tmp, "package.json"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "regular", type: "module", main: "./entry.ts" }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = 1;\n`, "utf8");
    writeFileSync(
      join(tmp, "orphan.ts"),
      `export function neverCalled() { return 2; }\n`,
      "utf8",
    );
    const result = await scanMonorepo({ rootDir: tmp, verbose: true });
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});
