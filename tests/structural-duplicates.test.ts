import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";

function setupFixture(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", main: "./index.ts" }),
    "utf8",
  );
  return tmp;
}

describe("structural duplicates: three same-shape hash functions", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-struct-hash-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a sha256/sha1/md5-style triplet as one duplicate group", async () => {
    writeFileSync(
      join(tmp, "index.ts"),
      `type Algo = { name: string; alias: string };
async function createHash(data: string, _algo: Algo): Promise<string> { return data; }

export const sha256 = async (data: string): Promise<string> => {
  const algorithm: Algo = { name: "SHA-256", alias: "sha256" };
  const hash = await createHash(data, algorithm);
  return hash;
};

export const sha1 = async (data: string): Promise<string> => {
  const algorithm: Algo = { name: "SHA-1", alias: "sha1" };
  const hash = await createHash(data, algorithm);
  return hash;
};

export const md5 = async (data: string): Promise<string> => {
  const algorithm: Algo = { name: "MD5", alias: "md5" };
  const hash = await createHash(data, algorithm);
  return hash;
};

export const _use = [sha256, sha1, md5];
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const struct = result.issues.filter(
      (i) => i.kind === "duplicate" && i.preview.includes("same AST shape"),
    );
    expect(struct).toHaveLength(1);
    if (struct[0].kind === "duplicate") {
      expect(struct[0].matches.length).toBe(2);
      expect(struct[0].preview).toMatch(/sha256.*sha1.*md5|sha1.*md5.*sha256|md5.*sha256.*sha1/);
    }
  });
});

describe("structural duplicates: small body skipped", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-struct-small-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag trivial { return x; } pairs", async () => {
    writeFileSync(
      join(tmp, "index.ts"),
      `export const a = (x: number) => { return x; };
export const b = (x: number) => { return x; };
export const _use = [a, b];
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const struct = result.issues.filter(
      (i) => i.kind === "duplicate" && i.preview.includes("same AST shape"),
    );
    expect(struct).toHaveLength(0);
  });
});

describe("structural duplicates: distinct-name guard", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setupFixture("slp-struct-samenames-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT flag same-name methods across classes (interface impl)", async () => {
    writeFileSync(
      join(tmp, "index.ts"),
      `interface Renderable { render(): string; dispose(): void }
export class A implements Renderable {
  render(): string {
    const tag = "a";
    const id = 1;
    const flag = true;
    const arr = [tag, id, flag];
    return arr.join(":");
  }
  dispose(): void {
    const tag = "a";
    const id = 1;
    const flag = true;
    const arr = [tag, id, flag];
    console.log(arr.join(":"));
  }
}
export class B implements Renderable {
  render(): string {
    const tag = "b";
    const id = 2;
    const flag = false;
    const arr = [tag, id, flag];
    return arr.join(":");
  }
  dispose(): void {
    const tag = "b";
    const id = 2;
    const flag = false;
    const arr = [tag, id, flag];
    console.log(arr.join(":"));
  }
}
export const _use = [new A(), new B()];
`,
      "utf8",
    );

    const result = await scan({ rootDir: tmp, only: ["duplicates"] });
    const struct = result.issues.filter(
      (i) => i.kind === "duplicate" && i.preview.includes("same AST shape"),
    );
    for (const s of struct) {
      if (s.kind !== "duplicate") continue;
      const names = s.preview.split(" — ")[0].split(" / ");
      expect(new Set(names).size).toBeGreaterThan(1);
    }
  });
});
