import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setupMonorepo(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "monorepo-root", workspaces: ["packages/*"] }),
    "utf8",
  );
  return tmp;
}

function addPackage(root: string, name: string, files: Record<string, string>): void {
  const dir = join(root, "packages", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `@scope/${name}`, type: "module", main: "./src/index.ts" }),
    "utf8",
  );
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(target.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

describe("monorepo: workspace-package promotion across detectors", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupMonorepo("slp-monorepo-beta-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag dead-code in @scope/a when @scope/b consumes it", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export { Button } from "./Button";\nexport { Card } from "./Card";\n`,
      "src/Button.tsx": `export function Button() { return null; }\nexport const buttonStyle = "default";\n`,
      "src/Card.tsx": `export function Card() { return null; }\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { Button } from "@scope/a";\nexport function App() { return Button(); }\n`,
    });

    const result = await scan({ rootDir: tmp });
    const deadInA = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "location" in i &&
        i.location.file.includes("packages/a/"),
    );
    expect(deadInA).toHaveLength(0);
  });

  it("flags dead-code in an imported workspace package's sibling that no-one consumes", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const used = 1;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { used } from "@scope/a";\nexport const z = used;\n`,
    });
    addPackage(tmp, "c", {
      "src/index.ts": `export function never_called() { return 1; }\n`,
      "src/dead.ts": `export function totally_dead_helper() { return 2; }\n`,
    });

    const result = await scan({ rootDir: tmp });
    const deadInC = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "location" in i &&
        i.location.file.includes("packages/c/src/dead.ts"),
    );
    expect(deadInC.length).toBeGreaterThan(0);
  });

  it("supports pnpm workspace declaration", async () => {
    rmSync(join(tmp, "package.json"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "monorepo-root" }),
      "utf8",
    );
    writeFileSync(join(tmp, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`, "utf8");
    addPackage(tmp, "lib", {
      "src/index.ts": `export const value = 42;\n`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { value } from "@scope/lib";\nexport const x = value;\n`,
    });
    const result = await scan({ rootDir: tmp });
    const deadInLib = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "location" in i &&
        i.location.file.includes("packages/lib/"),
    );
    expect(deadInLib).toHaveLength(0);
  });

  it("handles workspace package subpath imports `@scope/a/sub`", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export const root = 1;\n`,
      "src/sub.ts": `export const fromSub = 2;\n`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import { fromSub } from "@scope/a/sub";\nexport const x = fromSub;\n`,
    });
    const result = await scan({ rootDir: tmp });
    const deadInA = result.issues.filter(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        "location" in i &&
        i.location.file.includes("packages/a/"),
    );
    expect(deadInA).toHaveLength(0);
  });
});

describe("monorepo: detectors fire inside workspace packages", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupMonorepo("slp-monorepo-detectors-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("empty-wrapper inside a consumed workspace package fires", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export { compute } from "./helpers";\n`,
      "src/helpers.ts": `function realCompute(x: number) { return x * 2; }
export function compute(x: number) { return realCompute(x); }
`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { compute } from "@scope/lib";\nexport const y = compute(3);\n`,
    });
    const result = await scan({ rootDir: tmp });
    const wrappers = result.issues.filter(
      (i) => i.kind === "empty-wrapper" && i.outerName === "compute",
    );
    expect(wrappers.length).toBeGreaterThan(0);
  });

  it("empty-catch inside workspace package fires", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export function risky() {
  try { JSON.parse("{}"); } catch (e) {}
}
`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { risky } from "@scope/lib";\nrisky();\nexport const z = 1;\n`,
    });
    const result = await scan({ rootDir: tmp });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches.length).toBeGreaterThan(0);
  });

  it("useless-async inside workspace package fires", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export async function poll() {
  return 42;
}
`,
    });
    addPackage(tmp, "app", {
      "src/index.ts": `import { poll } from "@scope/lib";\npoll();\nexport const z = 1;\n`,
    });
    const result = await scan({ rootDir: tmp });
    const async = result.issues.filter(
      (i) => i.kind === "useless-async" && i.functionName === "poll",
    );
    expect(async.length).toBeGreaterThan(0);
  });

  it("same-shape-types across workspace packages fires", async () => {
    addPackage(tmp, "a", {
      "src/index.ts": `export interface UserDTO {
  id: string;
  name: string;
  email: string;
}
`,
    });
    addPackage(tmp, "b", {
      "src/index.ts": `import "@scope/a";
export interface AccountDTO {
  id: string;
  name: string;
  email: string;
}
`,
    });
    const result = await scan({ rootDir: tmp });
    const shapes = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(shapes.length).toBeGreaterThan(0);
  });
});

describe("monorepo: orphaned-file insight is suppressed", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupMonorepo("slp-monorepo-orphan-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does not emit orphaned-file insight in a workspace root", async () => {
    addPackage(tmp, "lib", {
      "src/index.ts": `export const x = 1;\n`,
      "src/unused.ts": `export function never() { return 0; }\n`,
    });
    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });
});

describe("monorepo: per-package tsconfig#paths via alias-tail fallback", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupMonorepo("slp-monorepo-aliases-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves a sub-package `@/foo/bar` import via path-tail match", async () => {
    addPackage(tmp, "app", {
      "src/index.ts": `import { MainMenu } from "@/components/main-menu";\nexport const X = MainMenu;\n`,
      "src/components/main-menu.tsx": `export function MainMenu() { return null; }\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
    });
    const result = await scan({ rootDir: tmp });
    const deadMain = result.issues.find(
      (i) =>
        (i.kind === "dead-code" || i.kind === "unused-export") &&
        i.kind !== "duplicate" &&
        i.kind !== "same-shape-types" &&
        "symbol" in i &&
        i.symbol === "MainMenu",
    );
    expect(deadMain).toBeUndefined();
  });
});
