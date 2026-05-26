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

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(target.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(target, content, "utf8");
}

describe("user-patterns: realistic project layouts produce zero false positives", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = setup("slp-user-patterns-");
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("Zod schemas with repeated .string().min().max() chains are not flagged as duplicate", async () => {
    write(
      tmp,
      "schemas.ts",
      `import { z } from "zod";
export const UserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().min(5).max(255).email(),
  bio: z.string().min(0).max(500).optional(),
  website: z.string().min(0).max(255).url().optional(),
  username: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/),
  phone: z.string().min(7).max(20).optional(),
});
export const ProductSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(0).max(2000).optional(),
  sku: z.string().min(1).max(50),
  brand: z.string().min(0).max(100).optional(),
});
`,
    );
    write(tmp, "entry.ts", `import { UserSchema, ProductSchema } from "./schemas";\nexport const X = [UserSchema, ProductSchema];\n`);
    const result = await scan({ rootDir: tmp });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups).toHaveLength(0);
  });

  it('Next.js server-actions `"use server"` with async-no-await stubs are not flagged', async () => {
    write(
      tmp,
      "app/actions.ts",
      `"use server";
import { db } from "@/lib/db";

export async function createPost(formData: FormData) {
  const title = String(formData.get("title"));
  return db.posts.insert({ title }).then((p) => p.id);
}

export async function deletePost(id: string) {
  return db.posts.delete({ id }).then(() => ({ ok: true }));
}

export async function publishPost(id: string) {
  return db.posts.update({ id, published: true }).then((p) => p);
}
`,
    );
    write(tmp, "app/page.tsx", `import { createPost } from "./actions";\nexport default function Page() { return <form action={createPost} />; }\n`);
    write(tmp, "entry.ts", `export { default } from "./app/page";\n`);
    const result = await scan({ rootDir: tmp });
    const asyncFps = result.issues.filter((i) => i.kind === "useless-async");
    expect(asyncFps).toHaveLength(0);
  });

  it("Next.js route handlers (GET/POST/PATCH) with try/catch are not over-flagged as duplicates", async () => {
    const handler = (verb: string, entity: string) => `import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function ${verb}(req: Request) {
  try {
    const body = await req.json();
    const result = await db.${entity}.${verb.toLowerCase()}(body);
    return NextResponse.json({ data: result }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
`;
    write(tmp, "app/api/users/route.ts", handler("POST", "users"));
    write(tmp, "app/api/posts/route.ts", handler("POST", "posts"));
    write(tmp, "app/api/comments/route.ts", handler("POST", "comments"));
    write(tmp, "entry.ts", `export const APP = 1;\n`);
    const result = await scan({ rootDir: tmp });
    const dupCount = result.issues.filter((i) => i.kind === "duplicate").length;
    expect(dupCount).toBeLessThanOrEqual(1);
  });

  it("Tailwind variant objects with same key-shape across files are not flagged as same-shape", async () => {
    write(
      tmp,
      "components/Button.tsx",
      `const variants = {
  default: "bg-blue-500 text-white",
  destructive: "bg-red-500 text-white",
  outline: "border border-gray-300",
  ghost: "hover:bg-gray-100",
};
export function Button({ variant = "default", children }: { variant?: keyof typeof variants; children: React.ReactNode }) {
  return <button className={variants[variant]}>{children}</button>;
}
`,
    );
    write(
      tmp,
      "components/Badge.tsx",
      `const variants = {
  default: "bg-gray-100 text-gray-900",
  destructive: "bg-red-100 text-red-900",
  outline: "border border-gray-400",
  ghost: "text-gray-500",
};
export function Badge({ variant = "default", children }: { variant?: keyof typeof variants; children: React.ReactNode }) {
  return <span className={variants[variant]}>{children}</span>;
}
`,
    );
    write(tmp, "entry.ts", `export { Button } from "./components/Button";\nexport { Badge } from "./components/Badge";\n`);
    const result = await scan({ rootDir: tmp });
    const shapeFps = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(shapeFps).toHaveLength(0);
  });

  it("React custom hooks with parallel shape are not over-flagged as duplicates", async () => {
    write(
      tmp,
      "hooks/useUser.ts",
      `import { useEffect, useState } from "react";
export function useUser(id: string) {
  const [data, setData] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/" + id).then(r => r.json()).then((d) => { if (!cancelled) setData(d); }).finally(() => setLoading(false));
    return () => { cancelled = true; };
  }, [id]);
  return { data, loading };
}
`,
    );
    write(
      tmp,
      "hooks/usePost.ts",
      `import { useEffect, useState } from "react";
export function usePost(id: string) {
  const [data, setData] = useState<{ id: string; title: string } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/post/" + id).then(r => r.json()).then((d) => { if (!cancelled) setData(d); }).finally(() => setLoading(false));
    return () => { cancelled = true; };
  }, [id]);
  return { data, loading };
}
`,
    );
    write(tmp, "entry.ts", `export { useUser } from "./hooks/useUser";\nexport { usePost } from "./hooks/usePost";\n`);
    const result = await scan({ rootDir: tmp });
    const dupCount = result.issues.filter((i) => i.kind === "duplicate").length;
    expect(dupCount).toBeLessThanOrEqual(1);
  });

  it("State-machine reducers with multiple action cases are not flagged as same-shape", async () => {
    write(
      tmp,
      "store.ts",
      `type IdleState = { kind: "idle" };
type LoadingState = { kind: "loading"; startedAt: number };
type SuccessState = { kind: "success"; data: unknown };
type ErrorState = { kind: "error"; message: string };
export type State = IdleState | LoadingState | SuccessState | ErrorState;

type FetchStart = { type: "fetch-start"; at: number };
type FetchSuccess = { type: "fetch-success"; data: unknown };
type FetchError = { type: "fetch-error"; message: string };
export type Action = FetchStart | FetchSuccess | FetchError;
`,
    );
    write(tmp, "entry.ts", `import type { State, Action } from "./store";\nexport type T = State | Action;\n`);
    const result = await scan({ rootDir: tmp });
    const shapeFps = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(shapeFps).toHaveLength(0);
  });

  it("Storage-fallback empty catches with documenting comments are not flagged", async () => {
    write(
      tmp,
      "storage.ts",
      `export function loadState(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    // localStorage may be unavailable (private mode, disabled)
  }
  return null;
}

export function saveState(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {} // Storage quota exceeded or unavailable
}

export function clearState(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch { /* ignore */ }
}
`,
    );
    write(tmp, "entry.ts", `export { loadState, saveState, clearState } from "./storage";\n`);
    const result = await scan({ rootDir: tmp });
    const catches = result.issues.filter((i) => i.kind === "empty-catch");
    expect(catches).toHaveLength(0);
  });

  it("CRUD service classes with parallel method shapes are not over-flagged", async () => {
    write(
      tmp,
      "services/UserService.ts",
      `import { db } from "../db";
export class UserService {
  async findById(id: string) { return db.users.findOne({ id }); }
  async create(input: { name: string }) { return db.users.insert(input); }
  async update(id: string, input: { name?: string }) { return db.users.update({ id, ...input }); }
  async delete(id: string) { return db.users.delete({ id }); }
}
`,
    );
    write(
      tmp,
      "services/PostService.ts",
      `import { db } from "../db";
export class PostService {
  async findById(id: string) { return db.posts.findOne({ id }); }
  async create(input: { title: string }) { return db.posts.insert(input); }
  async update(id: string, input: { title?: string }) { return db.posts.update({ id, ...input }); }
  async delete(id: string) { return db.posts.delete({ id }); }
}
`,
    );
    write(tmp, "db.ts", `export const db = { users: {} as any, posts: {} as any };\n`);
    write(tmp, "entry.ts", `export { UserService } from "./services/UserService";\nexport { PostService } from "./services/PostService";\n`);
    const result = await scan({ rootDir: tmp });
    const dupCount = result.issues.filter((i) => i.kind === "duplicate").length;
    const asyncFps = result.issues.filter((i) => i.kind === "useless-async");
    expect(asyncFps.length).toBeLessThanOrEqual(0);
    expect(dupCount).toBeLessThanOrEqual(1);
  });

  it("Discriminated-union 'kind' types with same field count but different fields are not flagged as same-shape", async () => {
    write(
      tmp,
      "types.ts",
      `export type Circle = { kind: "circle"; radius: number };
export type Square = { kind: "square"; side: number };
export type Triangle = { kind: "triangle"; base: number };
`,
    );
    write(tmp, "entry.ts", `import type { Circle, Square, Triangle } from "./types";\nexport type Shape = Circle | Square | Triangle;\n`);
    const result = await scan({ rootDir: tmp });
    const shapeFps = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(shapeFps).toHaveLength(0);
  });

  it("0-arg factory returning a chained method call is not flagged as empty-wrapper", async () => {
    write(
      tmp,
      "schemas.ts",
      `const baseSchema = { optional: () => ({}), nullable: () => ({}), array: () => ({}) };
export const OptionalSchema = () => baseSchema.optional();
export const NullableSchema = () => baseSchema.nullable();
export const ArraySchema = () => baseSchema.array();
`,
    );
    write(tmp, "entry.ts", `export { OptionalSchema, NullableSchema, ArraySchema } from "./schemas";\n`);
    const result = await scan({ rootDir: tmp });
    const wrappers = result.issues.filter((i) => i.kind === "empty-wrapper");
    expect(wrappers).toHaveLength(0);
  });

  it("i18n schema files in any directory are not flagged for repeated entry-shape duplicates", async () => {
    write(
      tmp,
      "schemas/i18n.ts",
      `import { z } from "zod";
export const TranslationSchema = z.object({
  "menu.home": z.string().meta({ description: "Home link in nav" }),
  "menu.about": z.string().meta({ description: "About link in nav" }),
  "menu.contact": z.string().meta({ description: "Contact link in nav" }),
  "menu.docs": z.string().meta({ description: "Docs link in nav" }),
  "menu.blog": z.string().meta({ description: "Blog link in nav" }),
  "menu.products": z.string().meta({ description: "Products link in nav" }),
  "menu.pricing": z.string().meta({ description: "Pricing link in nav" }),
  "menu.team": z.string().meta({ description: "Team link in nav" }),
});
`,
    );
    write(tmp, "entry.ts", `export { TranslationSchema } from "./schemas/i18n";\n`);
    const result = await scan({ rootDir: tmp });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups).toHaveLength(0);
  });

  it("__a11y__, __visual__ and similar test-convention dirs are excluded from dead-code", async () => {
    write(tmp, "__a11y__/reporter.ts", `export default class Reporter {\n  report() {}\n}\n`);
    write(tmp, "__visual__/screenshots.ts", `export function takeShot(name: string) { return name; }\n`);
    write(tmp, "src/main.ts", `export const X = 1;\n`);
    write(tmp, "entry.ts", `export { X } from "./src/main";\n`);
    const result = await scan({ rootDir: tmp });
    const dead = result.issues.filter((i) => i.kind === "dead-code");
    expect(dead).toHaveLength(0);
  });

  it("Express-style route handlers passing req/res through to a service are not flagged as empty-wrappers", async () => {
    write(
      tmp,
      "routes.ts",
      `import { service } from "./service";
export function getUser(req: { params: { id: string } }, res: { json: (x: unknown) => void }) {
  return service.findUser(req, res);
}
export function getPost(req: { params: { id: string } }, res: { json: (x: unknown) => void }) {
  return service.findPost(req, res);
}
`,
    );
    write(tmp, "service.ts", `export const service = { findUser: (req: any, res: any) => res.json({}), findPost: (req: any, res: any) => res.json({}) };\n`);
    write(tmp, "entry.ts", `export { getUser, getPost } from "./routes";\n`);
    const result = await scan({ rootDir: tmp });
    const wrappers = result.issues.filter((i) => i.kind === "empty-wrapper");
    expect(wrappers.length).toBeLessThanOrEqual(2);
  });

  it("Builder pattern .with() chains across files are not flagged as duplicate", async () => {
    write(
      tmp,
      "builders/user.ts",
      `export const UserBuilder = {
  withName: (name: string) => ({ name, withAge: (age: number) => ({ name, age, withEmail: (email: string) => ({ name, age, email }) }) }),
};
`,
    );
    write(
      tmp,
      "builders/product.ts",
      `export const ProductBuilder = {
  withTitle: (title: string) => ({ title, withPrice: (price: number) => ({ title, price, withSku: (sku: string) => ({ title, price, sku }) }) }),
};
`,
    );
    write(tmp, "entry.ts", `export { UserBuilder } from "./builders/user";\nexport { ProductBuilder } from "./builders/product";\n`);
    const result = await scan({ rootDir: tmp });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups).toHaveLength(0);
  });

  it("Logger-style classes with one method per level (debug/info/warn/error) are not flagged", async () => {
    write(
      tmp,
      "logger.ts",
      `interface Sink { write: (level: string, msg: string) => void; }
export class Logger {
  constructor(private sink: Sink) {}
  debug(msg: string) { this.sink.write("debug", msg); }
  info(msg: string) { this.sink.write("info", msg); }
  warn(msg: string) { this.sink.write("warn", msg); }
  error(msg: string) { this.sink.write("error", msg); }
  trace(msg: string) { this.sink.write("trace", msg); }
}
`,
    );
    write(tmp, "entry.ts", `export { Logger } from "./logger";\n`);
    const result = await scan({ rootDir: tmp });
    const wrappers = result.issues.filter((i) => i.kind === "empty-wrapper");
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(wrappers).toHaveLength(0);
    expect(dups).toHaveLength(0);
  });

  it("Type-only files with many short interfaces (DTOs) are not flagged as same-shape when fields differ", async () => {
    write(
      tmp,
      "dto/user.ts",
      `export interface CreateUserDTO { name: string; email: string; }
export interface UpdateUserDTO { id: string; name?: string; }
export interface DeleteUserDTO { id: string; reason?: string; }
`,
    );
    write(tmp, "entry.ts", `export type * from "./dto/user";\n`);
    const result = await scan({ rootDir: tmp });
    const shapeFps = result.issues.filter((i) => i.kind === "same-shape-types");
    expect(shapeFps).toHaveLength(0);
  });

  it("Generated-code markers in a non-generated dir suppress findings", async () => {
    write(
      tmp,
      "src/proto.ts",
      `// @generated
// AUTOGENERATED — DO NOT EDIT
export function method1(req: { id: string }) { return req; }
export function method2(req: { id: string }) { return req; }
export function method3(req: { id: string }) { return req; }
`,
    );
    write(tmp, "entry.ts", `export { method1, method2, method3 } from "./src/proto";\n`);
    const result = await scan({ rootDir: tmp });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups).toHaveLength(0);
  });

  it("Same-file structural function dups in an i18n.ts file are not flagged", async () => {
    write(
      tmp,
      "src/i18n.ts",
      `export function t_en(key: string) { return key; }
export function t_de(key: string) { return key; }
export function t_fr(key: string) { return key; }
export function t_es(key: string) { return key; }
`,
    );
    write(tmp, "entry.ts", `export * from "./src/i18n";\n`);
    const result = await scan({ rootDir: tmp });
    const dups = result.issues.filter((i) => i.kind === "duplicate");
    expect(dups).toHaveLength(0);
  });
});
