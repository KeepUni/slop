import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fg from "fast-glob";

export function isMonorepo(rootDir: string): boolean {
  return hasWorkspacesInPackageJson(rootDir) || hasPnpmWorkspaceFile(rootDir);
}

export interface WorkspacePackage {
  name: string;
  dir: string;
}

export function discoverWorkspacePackages(rootDir: string): WorkspacePackage[] {
  if (!isMonorepo(rootDir)) return [];
  const patterns = workspaceGlobPatterns(rootDir);
  if (patterns.length === 0) return [];

  const packageJsons = fg.sync(
    patterns.map((p) => (p.endsWith("/") ? `${p}package.json` : `${p}/package.json`)),
    { cwd: rootDir, absolute: true, dot: false, onlyFiles: true, ignore: ["**/node_modules/**"] },
  );

  const out: WorkspacePackage[] = [];
  for (const pkgPath of packageJsons) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg?.name !== "string" || pkg.name.length === 0) continue;
      out.push({ name: pkg.name, dir: dirname(pkgPath).replace(/\\/g, "/") });
    } catch (_err) {}
  }
  return out;
}

function workspaceGlobPatterns(rootDir: string): string[] {
  const patterns: string[] = [];
  const rootPkgPath = join(rootDir, "package.json");
  if (existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
      const ws = pkg.workspaces;
      if (Array.isArray(ws)) patterns.push(...ws.filter((p) => typeof p === "string"));
      else if (Array.isArray(ws?.packages))
        patterns.push(...ws.packages.filter((p: unknown) => typeof p === "string"));
    } catch (_err) {}
  }

  const pnpmPath = join(rootDir, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      const text = readFileSync(pnpmPath, "utf8");
      const re = /^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm;
      for (const m of text.matchAll(re)) patterns.push(m[1].trim());
    } catch (_err) {}
  }
  return patterns;
}

export const CONSUMED_ALL = "*";

const NAMED_IMPORT_RE =
  /(?:import\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?|export\s+(?:type\s+)?\{[^}]*\}\s+from\s+)["']([^"']+)["']/g;
const NAMED_BLOCK_RE = /\{([^}]+)\}/g;
const NAMESPACE_IMPORT_RE =
  /import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
const DEFAULT_IMPORT_RE =
  /import\s+(?:type\s+)?[A-Za-z_$][\w$]*\s+(?:,\s*\{[^}]*\}\s+)?from\s+["']([^"']+)["']/g;
const STAR_REEXPORT_RE =
  /export\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+["']([^"']+)["']/g;

interface PackageExports {
  named: Set<string>;
  defaultName: string | undefined;
}

export function collectCrossWorkspaceImports(
  rootDir: string,
  packages: WorkspacePackage[],
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const pkg of packages) refs.set(pkg.dir, new Set<string>());
  if (packages.length === 0) return refs;

  const namesByPackage = new Map<string, string>();
  for (const pkg of packages) namesByPackage.set(pkg.name, pkg.dir);

  const exportsByPackage = new Map<string, PackageExports>();
  for (const pkg of packages) exportsByPackage.set(pkg.dir, readPackageExports(pkg.dir));

  const sources = fg.sync("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: rootDir,
    absolute: true,
    dot: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**"],
  });

  for (const file of sources) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (_err) {
      continue;
    }
    const text = stripCommentsAndStrings(raw);
    const norm = file.replace(/\\/g, "/");

    for (const m of text.matchAll(NAMED_IMPORT_RE)) {
      const spec = m[1];
      const targetDir = resolveWorkspaceTarget(spec, namesByPackage);
      if (!targetDir || norm.startsWith(`${targetDir}/`)) continue;
      const set = refs.get(targetDir);
      if (!set) continue;
      for (const named of m[0].matchAll(NAMED_BLOCK_RE)) {
        for (const part of named[1].split(",")) {
          const trimmed = part.trim().replace(/^type\s+/, "");
          const original = trimmed.split(/\s+as\s+/)[0].trim();
          if (original) set.add(original);
        }
      }
    }

    for (const m of text.matchAll(DEFAULT_IMPORT_RE)) {
      const spec = m[1];
      const targetDir = resolveWorkspaceTarget(spec, namesByPackage);
      if (!targetDir || norm.startsWith(`${targetDir}/`)) continue;
      const set = refs.get(targetDir);
      if (!set) continue;
      const exp = exportsByPackage.get(targetDir);
      if (exp?.defaultName) set.add(exp.defaultName);
      else set.add(CONSUMED_ALL);
    }

    for (const m of text.matchAll(NAMESPACE_IMPORT_RE)) {
      const alias = m[1];
      const spec = m[2];
      const targetDir = resolveWorkspaceTarget(spec, namesByPackage);
      if (!targetDir || norm.startsWith(`${targetDir}/`)) continue;
      const set = refs.get(targetDir);
      if (!set) continue;
      const accessed = collectMemberAccesses(text, alias);
      if (accessed.size === 0) {
        set.add(CONSUMED_ALL);
        continue;
      }
      for (const name of accessed) set.add(name);
    }

    for (const m of text.matchAll(STAR_REEXPORT_RE)) {
      const targetDir = resolveWorkspaceTarget(m[1], namesByPackage);
      if (!targetDir || norm.startsWith(`${targetDir}/`)) continue;
      const set = refs.get(targetDir);
      if (set) set.add(CONSUMED_ALL);
    }
  }

  return refs;
}

function stripCommentsAndStrings(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n - 1 && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && s[i] !== quote) {
        if (s[i] === "\\" && i + 1 < n) {
          out += s[i] + s[i + 1];
          i += 2;
          continue;
        }
        if (quote === "`" && s[i] === "$" && s[i + 1] === "{") {
          out += s[i] + s[i + 1];
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (s[i] === "{") depth++;
            else if (s[i] === "}") depth--;
            out += s[i];
            i++;
          }
          continue;
        }
        out += s[i];
        i++;
      }
      if (i < n) {
        out += s[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function collectMemberAccesses(source: string, alias: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`\\b${escapeRegex(alias)}\\.([A-Za-z_$][\\w$]*)`, "g");
  for (const m of source.matchAll(re)) out.add(m[1]);
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPackageExports(pkgDir: string): PackageExports {
  const out: PackageExports = { named: new Set<string>(), defaultName: undefined };
  const entry = locatePackageEntry(pkgDir);
  if (!entry) return out;
  let text: string;
  try {
    text = readFileSync(entry, "utf8");
  } catch (_err) {
    return out;
  }
  collectExportsFromSource(text, out);
  return out;
}

function locatePackageEntry(pkgDir: string): string | undefined {
  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  let main: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof pkg.main === "string") main = pkg.main;
    else if (typeof pkg.module === "string") main = pkg.module;
    else if (typeof pkg.exports === "string") main = pkg.exports;
    else if (pkg.exports && typeof pkg.exports === "object") {
      const dot = (pkg.exports as Record<string, unknown>)["."];
      if (typeof dot === "string") main = dot;
      else if (dot && typeof dot === "object") {
        const inner = dot as Record<string, unknown>;
        const candidate = inner.import ?? inner.default ?? inner.require;
        if (typeof candidate === "string") main = candidate;
      }
    }
  } catch (_err) {
    return undefined;
  }
  // source-first: pre-built `dist/index.js` would yield empty exports under regex.
  const sourceCandidates: string[] = [];
  for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) {
    sourceCandidates.push(join(pkgDir, `src/index.${ext}`));
    sourceCandidates.push(join(pkgDir, `index.${ext}`));
  }
  for (const c of sourceCandidates) if (existsSync(c)) return c;
  if (main) {
    const mainPath = join(pkgDir, main);
    if (existsSync(mainPath)) return mainPath;
  }
  return undefined;
}

const EXPORT_DEFAULT_FN_RE = /export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const EXPORT_DEFAULT_CLASS_RE = /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/;
const EXPORT_DEFAULT_IDENT_RE = /export\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/m;
const EXPORT_NAMED_DECL_RE =
  /export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_NAMED_LIST_RE = /export\s+(?:type\s+)?\{([^}]+)\}(?!\s*from)/g;
const EXPORT_REEXPORT_LIST_RE = /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;

function collectExportsFromSource(text: string, out: PackageExports): void {
  const fnMatch = text.match(EXPORT_DEFAULT_FN_RE);
  if (fnMatch) out.defaultName = fnMatch[1];
  if (!out.defaultName) {
    const clsMatch = text.match(EXPORT_DEFAULT_CLASS_RE);
    if (clsMatch) out.defaultName = clsMatch[1];
  }
  if (!out.defaultName) {
    const identMatch = text.match(EXPORT_DEFAULT_IDENT_RE);
    if (identMatch) out.defaultName = identMatch[1];
  }

  for (const m of text.matchAll(EXPORT_NAMED_DECL_RE)) out.named.add(m[1]);

  for (const m of text.matchAll(EXPORT_NAMED_LIST_RE)) absorbNamedSpecifierList(m[1], out, false);
  for (const m of text.matchAll(EXPORT_REEXPORT_LIST_RE)) absorbNamedSpecifierList(m[1], out, true);
}

function absorbNamedSpecifierList(list: string, out: PackageExports, fromReexport: boolean): void {
  for (const part of list.split(",")) {
    const trimmed = part.trim().replace(/^type\s+/, "");
    if (!trimmed) continue;
    const renamed = trimmed.split(/\s+as\s+/);
    const original = renamed[0]?.trim();
    const exported = renamed[1]?.trim() ?? original;
    if (exported === "default") {
      if (fromReexport) {
        if (!out.defaultName) out.defaultName = original ?? "default";
      } else if (original && /^[A-Za-z_$][\w$]*$/.test(original)) {
        if (!out.defaultName) out.defaultName = original;
      }
      continue;
    }
    if (exported && /^[A-Za-z_$][\w$]*$/.test(exported)) out.named.add(exported);
  }
}

export function resolveWorkspaceTarget(
  spec: string,
  namesByPackage: Map<string, string>,
): string | undefined {
  const direct = namesByPackage.get(spec);
  if (direct) return direct;
  if (spec.startsWith("@")) {
    const second = spec.indexOf("/", spec.indexOf("/") + 1);
    if (second > 0) {
      const scoped = spec.slice(0, second);
      const found = namesByPackage.get(scoped);
      if (found) return found;
    }
  } else {
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const head = spec.slice(0, slash);
      const found = namesByPackage.get(head);
      if (found) return found;
    }
  }
  return undefined;
}

function hasWorkspacesInPackageJson(rootDir: string): boolean {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (Array.isArray(pkg.workspaces)) return true;
    if (
      pkg.workspaces &&
      typeof pkg.workspaces === "object" &&
      Array.isArray((pkg.workspaces as { packages?: unknown }).packages)
    ) {
      return true;
    }
    return false;
  } catch (_err) {
    return false;
  }
}

function hasPnpmWorkspaceFile(rootDir: string): boolean {
  return existsSync(join(rootDir, "pnpm-workspace.yaml"));
}
