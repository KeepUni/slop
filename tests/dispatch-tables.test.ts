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

describe("duplicates: dispatch-table bodies are not flagged structurally", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-dispatch-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("two unrelated switch-based dispatchers do not produce a structural duplicate", async () => {
    write(
      tmp,
      "src/actions.ts",
      `import { reduceUser, reduceCart, reduceCheckout, reduceOrder } from "./reducers.js";
export function handleAction(action: { type: string; payload: unknown }): unknown {
  switch (action.type) {
    case "USER_UPDATE":
      return reduceUser(action.payload);
    case "CART_ADD":
      return reduceCart(action.payload);
    case "CHECKOUT_START":
      return reduceCheckout(action.payload);
    case "ORDER_PLACED":
      return reduceOrder(action.payload);
    default:
      return null;
  }
}
`,
    );
    write(
      tmp,
      "src/events.ts",
      `import { onLogin, onLogout, onError, onTimeout } from "./handlers.js";
export function handleEvent(event: { kind: string; data: unknown }): unknown {
  switch (event.kind) {
    case "auth.login":
      return onLogin(event.data);
    case "auth.logout":
      return onLogout(event.data);
    case "system.error":
      return onError(event.data);
    case "session.timeout":
      return onTimeout(event.data);
    default:
      return null;
  }
}
`,
    );
    write(tmp, "src/reducers.ts", `export const reduceUser = (_: unknown) => 1;\nexport const reduceCart = (_: unknown) => 2;\nexport const reduceCheckout = (_: unknown) => 3;\nexport const reduceOrder = (_: unknown) => 4;\n`);
    write(tmp, "src/handlers.ts", `export const onLogin = (_: unknown) => 1;\nexport const onLogout = (_: unknown) => 2;\nexport const onError = (_: unknown) => 3;\nexport const onTimeout = (_: unknown) => 4;\n`);
    write(tmp, "entry.ts", `import { handleAction } from "./src/actions.js";\nimport { handleEvent } from "./src/events.js";\nexport const X = [handleAction, handleEvent];\n`);

    const result = await scan({ rootDir: tmp });
    const dispatchDup = result.issues.find(
      (i) =>
        i.kind === "duplicate" &&
        ((i.preview ?? "").includes("handleAction") || (i.preview ?? "").includes("handleEvent")),
    );
    expect(dispatchDup).toBeUndefined();
  });

  it("non-dispatch structural duplicates are still flagged", async () => {
    write(
      tmp,
      "src/hash-a.ts",
      `export async function sha256(data: string): Promise<string | null> {
  const algorithm = { name: "SHA-256", alias: "sha256" };
  const buffer = await crypto.subtle.digest(algorithm.name, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
`,
    );
    write(
      tmp,
      "src/hash-b.ts",
      `export async function sha1(data: string): Promise<string | null> {
  const algorithm = { name: "SHA-1", alias: "sha1" };
  const buffer = await crypto.subtle.digest(algorithm.name, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
`,
    );
    write(tmp, "entry.ts", `import { sha256 } from "./src/hash-a.js";\nimport { sha1 } from "./src/hash-b.js";\nexport const X = [sha256, sha1];\n`);

    const result = await scan({ rootDir: tmp });
    const dup = result.issues.find(
      (i) =>
        i.kind === "duplicate" &&
        (i.preview ?? "").match(/sha/i),
    );
    expect(dup).toBeDefined();
  });
});
