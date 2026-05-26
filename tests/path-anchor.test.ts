import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

describe("scan(): path argument anchors project root", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slp-path-anchor-"));

    mkdirSync(join(tmp, "app"), { recursive: true });
    mkdirSync(join(tmp, "components"), { recursive: true });

    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "anchor-fixture", type: "module", main: "./app/page.tsx" }),
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
          baseUrl: ".",
          paths: { "@/*": ["./*"] },
        },
        include: ["**/*.ts", "**/*.tsx"],
      }),
      "utf8",
    );
    writeFileSync(
      join(tmp, "components", "Button.tsx"),
      `export function Button() { return <button>click</button>; }\n`,
      "utf8",
    );
    writeFileSync(
      join(tmp, "app", "page.tsx"),
      `import { Button } from "@/components/Button";\nexport default function Page() { return <Button />; }\n`,
      "utf8",
    );
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("uses the target directory's own tsconfig, not the caller's", async () => {
    const result = await scan({
      rootDir: tmpdir(),
      paths: [tmp],
      only: ["dead-code"],
    });

    expect(result.rootDir.replace(/\\/g, "/")).toBe(tmp.replace(/\\/g, "/"));

    const deadSymbols = result.issues
      .filter((i) => i.kind === "dead-code")
      .map((i) => (i.kind === "dead-code" ? i.symbol : ""));

    expect(deadSymbols).not.toContain("Button");
  });
});
