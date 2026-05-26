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
  writeFileSync(join(tmp, "entry.ts"), `export const APP = 1;\n`, "utf8");
  return tmp;
}

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(target.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(target, content, "utf8");
}

describe("empty-wrappers: multi-statement variants", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-multistmt-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("`const x = bar(a); return x;` two-statement forward is flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `export function fetchUser(id: string) { return { id }; }
export function getUser(id: string) {
  const user = fetchUser(id);
  return user;
}
export const _x = getUser("1");
`,
    );
    const result = await scan({ rootDir: tmp });
    const wrapper = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "getUser",
    );
    expect(wrapper).toBeDefined();
  });

  it("`let x = bar(a); return x;` with let is also flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `export function realCall(n: number) { return n + 1; }
export function aliased(n: number) {
  let result = realCall(n);
  return result;
}
export const _x = aliased(1);
`,
    );
    const result = await scan({ rootDir: tmp });
    const wrapper = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "aliased",
    );
    expect(wrapper).toBeDefined();
  });

  it("async two-statement forward `const x = await bar(a); return x;` is flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `export async function fetchUser(id: string) { return { id }; }
export async function getUser(id: string) {
  const user = await fetchUser(id);
  return user;
}
export const _x = getUser("1");
`,
    );
    const result = await scan({ rootDir: tmp });
    const wrapper = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "getUser",
    );
    expect(wrapper).toBeDefined();
  });

  it("`return fetchUser(id) as User;` type-assertion wrapper is flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `interface User { id: string }
export function fetchUser(id: string): unknown { return { id }; }
export function getUser(id: string): User {
  return fetchUser(id) as User;
}
export const _x = getUser("1");
`,
    );
    const result = await scan({ rootDir: tmp });
    const wrapper = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "getUser",
    );
    expect(wrapper).toBeDefined();
  });

  it("three-statement bodies are NOT flagged (intermediate side-effect)", async () => {
    write(
      tmp,
      "lib.ts",
      `export function fetchUser(id: string) { return { id }; }
export function trackEvent(name: string) { return name; }
export function getUser(id: string) {
  const user = fetchUser(id);
  trackEvent("get-user");
  return user;
}
export const _x = getUser("1");
`,
    );
    const result = await scan({ rootDir: tmp });
    const wrapper = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "getUser",
    );
    expect(wrapper).toBeUndefined();
  });

  it("returning a DIFFERENT variable name (rebinding) is NOT flagged", async () => {
    write(
      tmp,
      "lib.ts",
      `export function fetchUser(id: string) { return { id }; }
export function getUser(id: string) {
  const user = fetchUser(id);
  const result = user;
  return result;
}
export const _x = getUser("1");
`,
    );
    const result = await scan({ rootDir: tmp });
    const wrapper = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "getUser",
    );
    expect(wrapper).toBeUndefined();
  });

  it("destructured assignment is NOT flagged (semantically different)", async () => {
    write(
      tmp,
      "lib.ts",
      `export function fetchUser(id: string) { return { id, name: "x" }; }
export function getUserId(id: string) {
  const { id: userId } = fetchUser(id);
  return userId;
}
export const _x = getUserId("1");
`,
    );
    const result = await scan({ rootDir: tmp });
    const wrapper = result.issues.find(
      (i) => i.kind === "empty-wrapper" && i.outerName === "getUserId",
    );
    expect(wrapper).toBeUndefined();
  });
});
