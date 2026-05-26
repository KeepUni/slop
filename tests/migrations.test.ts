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

describe("duplicates: migrations directory is treated as intentional repetition", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-migrations-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("structurally similar migrations across files are not flagged as duplicate", async () => {
    const migration = (table: string, col: string) => `import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("${table}")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("${col}", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamp", (c) => c.defaultTo("now()").notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("${table}").execute();
}
`;
    write(tmp, "migrations/2024-01-01-create-users.ts", migration("users", "email"));
    write(tmp, "migrations/2024-02-01-create-orders.ts", migration("orders", "status"));
    write(tmp, "migrations/2024-03-01-create-products.ts", migration("products", "sku"));
    write(tmp, "entry.ts", `export const APP = 1;\n`);

    const result = await scan({ rootDir: tmp, verbose: true });
    const dups = result.issues.filter(
      (i) =>
        i.kind === "duplicate" &&
        (i.primary.file.includes("migrations") ||
          i.matches.some((m) => m.file.includes("migrations"))),
    );
    expect(dups).toHaveLength(0);
  });

  it("non-migration duplicates outside migrations/ still surface", async () => {
    const dup = `import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("alpha")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamp", (c) => c.defaultTo("now()").notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("alpha").execute();
}
`;
    write(tmp, "src/a.ts", dup);
    write(tmp, "src/b.ts", dup.replace(/alpha/g, "beta"));
    write(tmp, "entry.ts", `import { up as upA } from "./src/a.js";\nimport { up as upB } from "./src/b.js";\nexport const APP = [upA, upB];\n`);

    const result = await scan({ rootDir: tmp, verbose: true });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups.length).toBeGreaterThan(0);
  });
});
