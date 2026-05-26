import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";
import { detectFrameworks } from "../src/core/framework-detection.js";

function mk(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("framework detection: package.json deps", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mk("slp-fw-detect-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("detects Next.js via next dep", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { next: "^14.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).has("next")).toBe(true);
  });

  it("detects SvelteKit via @sveltejs/kit", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).has("sveltekit")).toBe(true);
  });

  it("detects Astro", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { astro: "^4.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).has("astro")).toBe(true);
  });

  it("detects Remix via any @remix-run/* package", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@remix-run/react": "^2.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).has("remix")).toBe(true);
  });

  it("detects Nuxt", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ devDependencies: { nuxt: "^3.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).has("nuxt")).toBe(true);
  });

  it("detects SolidStart via @solidjs/start", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@solidjs/start": "^1.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).has("solid-start")).toBe(true);
  });

  it("detects Qwik via @builder.io/qwik", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@builder.io/qwik": "^1.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).has("qwik")).toBe(true);
  });

  it("returns empty set when no marker packages present", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
      "utf8",
    );
    expect(detectFrameworks(tmp).size).toBe(0);
  });

  it("returns empty set when package.json is malformed", () => {
    writeFileSync(join(tmp, "package.json"), "{ not valid json", "utf8");
    expect(detectFrameworks(tmp).size).toBe(0);
  });
});

describe("framework detection drives reachability: SvelteKit", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mk("slp-fw-sveltekit-");
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        devDependencies: { "@sveltejs/kit": "^2.0.0" },
      }),
      "utf8",
    );
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("recognizes +page.server.ts and +server.ts as entries", async () => {
    mkdirSync(join(tmp, "src", "routes"), { recursive: true });
    mkdirSync(join(tmp, "src", "routes", "api"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "routes", "+page.server.ts"),
      `export const load = async () => ({ items: [] });\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "routes", "api", "+server.ts"),
      `export const GET = async () => new Response("ok");\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });

  it("recognizes hooks.client.ts and hooks.server.ts as entries", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "hooks.server.ts"),
      `export const handle = async ({ event, resolve }: any) => resolve(event);\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });
});

describe("framework detection drives reachability: Astro", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mk("slp-fw-astro-");
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        dependencies: { astro: "^4.0.0" },
      }),
      "utf8",
    );
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("recognizes src/content/config.ts and src/pages/*.ts as entries", async () => {
    mkdirSync(join(tmp, "src", "content"), { recursive: true });
    mkdirSync(join(tmp, "src", "pages", "api"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "content", "config.ts"),
      `export const collections = {};\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "src", "pages", "api", "hello.ts"),
      `export const GET = async () => new Response("hi");\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });
});

describe("framework detection drives reachability: Remix", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mk("slp-fw-remix-");
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        dependencies: { "@remix-run/react": "^2.0.0" },
      }),
      "utf8",
    );
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("recognizes app/root.tsx and app/routes/* as entries", async () => {
    mkdirSync(join(tmp, "app", "routes"), { recursive: true });
    writeFileSync(
      join(tmp, "app", "root.tsx"),
      `export default function Root() { return null; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "app", "routes", "index.tsx"),
      `export default function Index() { return null; }\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });
});

describe("framework gating: prevents false positives", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mk("slp-fw-gating-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT treat composables/ as entries in a non-Nuxt project", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        main: "./entry.ts",
        dependencies: { lodash: "^4.0.0" },
      }),
      "utf8",
    );
    writeFileSync(join(tmp, "entry.ts"), `export const APP = "yes";\n`, "utf8");
    mkdirSync(join(tmp, "composables"), { recursive: true });
    writeFileSync(
      join(tmp, "composables", "useThing.ts"),
      `export function useThing() { return 1; }
export function useOther() { return 2; }
export function useThird() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans.length).toBeGreaterThan(0);
    const orphanFiles = orphans.map((o) =>
      o.kind === "orphaned-file" ? o.file.replace(/\\/g, "/") : "",
    );
    expect(orphanFiles.some((f) => f.endsWith("/composables/useThing.ts"))).toBe(true);
  });

  it("DOES treat composables/ as entries in a Nuxt project", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "fixture",
        type: "module",
        dependencies: { nuxt: "^3.0.0" },
      }),
      "utf8",
    );
    mkdirSync(join(tmp, "composables"), { recursive: true });
    writeFileSync(
      join(tmp, "composables", "useThing.ts"),
      `export function useThing() { return 1; }
export function useOther() { return 2; }
export function useThird() { return 3; }
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp });
    const orphans = result.insights.filter((i) => i.kind === "orphaned-file");
    expect(orphans).toHaveLength(0);
  });
});
