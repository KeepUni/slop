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

describe("empty-wrappers: JSX spread pass-through", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-jsx-wrap-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags `function W(props) { return <Inner {...props} /> }`", async () => {
    writeFileSync(
      join(tmp, "Inner.tsx"),
      `export function Inner(_props: { x: number }) { return null }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "Wrap.tsx"),
      `import { Inner } from "./Inner";
export function Wrap(props: { x: number }) {
  return <Inner {...props} />;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const w = result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "Wrap");
    expect(w).toBeDefined();
  });

  it("flags arrow `const W = (props) => <Inner {...props} />`", async () => {
    writeFileSync(
      join(tmp, "Inner.tsx"),
      `export function Inner(_props: { x: number }) { return null }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "Wrap.tsx"),
      `import { Inner } from "./Inner";
export const Wrap = (props: { x: number }) => <Inner {...props} />;
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    const w = result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "Wrap");
    expect(w).toBeDefined();
  });

  it("does NOT flag wrapper that adds extra props", async () => {
    writeFileSync(
      join(tmp, "Inner.tsx"),
      `export function Inner(_props: { x: number; tag: string }) { return null }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "Wrap.tsx"),
      `import { Inner } from "./Inner";
export function Wrap(props: { x: number }) {
  return <Inner {...props} tag="ok" />;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(
      result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "Wrap"),
    ).toBeUndefined();
  });

  it("does NOT flag wrapper with children", async () => {
    writeFileSync(
      join(tmp, "Inner.tsx"),
      `export function Inner(_props: { children?: unknown }) { return null }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "Wrap.tsx"),
      `import { Inner } from "./Inner";
export function Wrap(props: { x: number }) {
  return <Inner {...props}><span>hi</span></Inner>;
}
`,
      "utf8",
    );
    const result = await scan({ rootDir: tmp, only: ["empty-wrappers"] });
    expect(
      result.issues.find((i) => i.kind === "empty-wrapper" && i.outerName === "Wrap"),
    ).toBeUndefined();
  });
});
