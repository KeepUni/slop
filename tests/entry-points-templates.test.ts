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

describe("entry-points: template-file consumers (Astro / Vue / Svelte)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-templates-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("treats a .ts file imported by a .astro file as not-dead", async () => {
    mkdirSync(join(tmp, "components"), { recursive: true });
    writeFileSync(
      join(tmp, "components", "lib.ts"),
      `export function getPalettes(config: { x: number }) { return config.x; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "components", "page.astro"),
      `---
import { getPalettes } from './lib';
const out = getPalettes({ x: 1 });
---
<div>{out}</div>
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(
      result.issues.find((i) => i.kind === "dead-code" && i.symbol === "getPalettes"),
    ).toBeUndefined();
  });

  it("treats a .ts file imported by a .vue file as not-dead", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "util.ts"),
      `export function formatTitle(s: string) { return s.toUpperCase(); }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "Page.vue"),
      `<script setup>
import { formatTitle } from './util';
const title = formatTitle('hi');
</script>
<template><h1>{{ title }}</h1></template>
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(
      result.issues.find((i) => i.kind === "dead-code" && i.symbol === "formatTitle"),
    ).toBeUndefined();
  });

  it("treats a .ts file imported by a .svelte file as not-dead", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "helper.ts"),
      `export function compute(n: number) { return n * 2; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "Comp.svelte"),
      `<script>
  import { compute } from './helper';
  let value = compute(21);
</script>
<p>{value}</p>
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(
      result.issues.find((i) => i.kind === "dead-code" && i.symbol === "compute"),
    ).toBeUndefined();
  });

  it("handles `import type` and per-specifier type keyword", async () => {
    mkdirSync(join(tmp, "schemas"), { recursive: true });
    writeFileSync(
      join(tmp, "schemas", "badge.ts"),
      `export const BadgeComponentSchema = { kind: "badge" };
export type BadgeComponentProps = { variant: string };
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "schemas", "logo.ts"),
      `export type LogoConfig = { src: string };
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "Badge.astro"),
      `---
import { BadgeComponentSchema, type BadgeComponentProps } from './schemas/badge';
import type { LogoConfig } from './schemas/logo';
type Props = BadgeComponentProps & LogoConfig;
const _ = BadgeComponentSchema;
---
<span></span>
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(
      result.issues.find((i) => i.kind === "dead-code" && i.symbol === "BadgeComponentProps"),
    ).toBeUndefined();
    expect(
      result.issues.find((i) => i.kind === "dead-code" && i.symbol === "LogoConfig"),
    ).toBeUndefined();
    expect(
      result.issues.find((i) => i.kind === "dead-code" && i.symbol === "BadgeComponentSchema"),
    ).toBeUndefined();
  });

  it("still flags symbols not referenced by any template", async () => {
    mkdirSync(join(tmp, "components"), { recursive: true });
    writeFileSync(
      join(tmp, "components", "lib.ts"),
      `export function usedFn() { return 1; }
export function deadFn() { return 2; }
`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "components", "page.astro"),
      `---
import { usedFn } from './lib';
const x = usedFn();
---
<div>{x}</div>
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "deadFn")).toBeDefined();
    expect(result.issues.find((i) => i.kind === "dead-code" && i.symbol === "usedFn")).toBeUndefined();
  });
});

describe("insight: wrapper-only-file FP guard", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-wof-guard-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag wrapper-only when wrappers exceed top-level exports", async () => {
    writeFileSync(
      join(tmp, "fmt.ts"),
      `function deepFn(s: string) { return s; }
const strategies = {
  a: (s: string) => deepFn(s),
  b: (s: string) => deepFn(s),
};
export function createFmt() {
  return (s: string) => strategies.a(s);
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp });
    expect(result.insights.find((i) => i.kind === "wrapper-only-file")).toBeUndefined();
  });
});
