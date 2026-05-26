import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

describe("empty-wrappers: Next.js framework convention exemptions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-fw-exempt-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "fw-fixture", type: "module" }),
      "utf8",
    );
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          strict: true,
        },
        include: ["**/*.ts", "**/*.tsx"],
      }),
      "utf8",
    );
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does not flag HTTP-method exports in app/<route>/route.ts", async () => {
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(
      join(tmp, "lib", "revalidate.ts"),
      `export function revalidate(req: Request) { return new Response(); }\n`,
      "utf8",
    );
    mkdirSync(join(tmp, "app", "api", "revalidate"), { recursive: true });
    writeFileSync(
      join(tmp, "app", "api", "revalidate", "route.ts"),
      `import { revalidate } from "../../../lib/revalidate.js";\n` +
        `export async function POST(req: Request): Promise<Response> {\n` +
        `  return revalidate(req);\n` +
        `}\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).not.toContain("POST");
  });

  it("does not flag default export in app/.../opengraph-image.tsx", async () => {
    mkdirSync(join(tmp, "components"), { recursive: true });
    writeFileSync(
      join(tmp, "components", "og.tsx"),
      `export default function OpengraphImage() { return null; }\n`,
      "utf8",
    );
    mkdirSync(join(tmp, "app"), { recursive: true });
    writeFileSync(
      join(tmp, "app", "opengraph-image.tsx"),
      `import OpengraphImage from "../components/og.js";\n` +
        `export default async function Image() {\n` +
        `  return await OpengraphImage();\n` +
        `}\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).not.toContain("Image");
  });

  it("does not flag default export in pages/api handler", async () => {
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(
      join(tmp, "lib", "handle.ts"),
      `export function handle(req: unknown, res: unknown) { void req; void res; }\n`,
      "utf8",
    );
    mkdirSync(join(tmp, "pages", "api"), { recursive: true });
    writeFileSync(
      join(tmp, "pages", "api", "ping.ts"),
      `import { handle } from "../../lib/handle.js";\n` +
        `export default function handler(req: unknown, res: unknown) {\n` +
        `  return handle(req, res);\n` +
        `}\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).not.toContain("handler");
  });

  it("still flags a genuine pass-through wrapper in a normal file", async () => {
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(
      join(tmp, "lib", "users.ts"),
      `function fetchUser(id: string) { return { id }; }\n` +
        `export function getUser(id: string) { return fetchUser(id); }\n` +
        `export const _all = { getUser };\n`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const wrappers = result.issues
      .filter((i) => i.kind === "empty-wrapper")
      .map((i) => (i.kind === "empty-wrapper" ? i.outerName : ""));
    expect(wrappers).toContain("getUser");
  });
});
