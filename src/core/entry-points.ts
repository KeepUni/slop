import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import { safeGetSpecifierSourceFile, safeGetSpecifierValue } from "../utils/ast.js";
import { detectFrameworks, type FrameworkName } from "./framework-detection.js";
import { discoverWorkspacePackages } from "./monorepo.js";

const PACKAGE_DIR_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
];

const TOOL_CONFIG_NAMES =
  "postcss|tailwind|eslint|prettier|stylelint|babel|jest|vitest|playwright|cypress|webpack|rollup|esbuild|tsup|tsdown|drizzle|knip|biome|commitlint|lint-staged|markdoc|lunaria|panda|unocss|histoire|storybook|capacitor|electron-builder|expo|metro";

const UNIVERSAL_ENTRY_PATTERNS: string[] = [
  "(^|/)middleware\\.(ts|js)$",
  "(^|/)instrumentation\\.(ts|js)$",
  "(^|/)(next|vite|astro|svelte|nuxt|remix|vue)\\.config\\.(ts|js|mjs|cjs)$",
  `(^|/)(${TOOL_CONFIG_NAMES})\\.config\\.(ts|js|mjs|cjs)$`,
  `(^|/)\\.(${TOOL_CONFIG_NAMES})rc\\.(ts|js|mjs|cjs|json)$`,
  "(^|/)src/index\\.(ts|tsx|js|jsx|mjs)$",
  "(^|/)src/(main|App)\\.(ts|tsx|js|jsx|mjs)$",
  "^index\\.(ts|tsx|js|jsx|mjs)$",
];

const FRAMEWORK_ENTRY_PATTERNS: Record<FrameworkName, string[]> = {
  next: [
    "(^|/)app/(.+/)?(page|layout|route|loading|error|template|default|not-found|global-error|head|opengraph-image|twitter-image|icon|apple-icon|robots|sitemap|manifest)\\.(ts|tsx|js|jsx)$",
    "(^|/)pages/.+\\.(ts|tsx|js|jsx)$",
  ],
  sveltekit: [
    "(^|/)src/routes/.*\\+(page|layout|server|page\\.server|layout\\.server|error)\\.(ts|js)$",
    "(^|/)src/routes/.*\\+server\\.(ts|js)$",
    "(^|/)src/hooks\\.(client|server)\\.(ts|js)$",
    "(^|/)src/service-worker\\.(ts|js)$",
    "(^|/)src/app\\.(d\\.ts|html)$",
  ],
  astro: [
    "(^|/)src/pages/.+\\.(ts|js)$",
    "(^|/)src/content/config\\.(ts|js)$",
    "(^|/)src/content\\.config\\.(ts|js)$",
    "(^|/)src/middleware\\.(ts|js)$",
    "(^|/)astro\\.config\\.(ts|js|mjs|cjs)$",
  ],
  remix: [
    "(^|/)app/root\\.(tsx|jsx)$",
    "(^|/)app/entry\\.(client|server)\\.(tsx|jsx|ts|js)$",
    "(^|/)app/routes/.+\\.(tsx|ts|jsx|js)$",
    "(^|/)remix\\.config\\.(ts|js|mjs|cjs)$",
  ],
  nuxt: [
    "(^|/)pages/.+\\.(vue|ts|js)$",
    "(^|/)layouts/.+\\.(vue|ts|js)$",
    "(^|/)plugins/.+\\.(ts|js)$",
    "(^|/)middleware/.+\\.(ts|js)$",
    "(^|/)composables/.+\\.(ts|js)$",
    "(^|/)server/.+\\.(ts|js)$",
    "(^|/)app\\.(vue|ts|js)$",
    "(^|/)nuxt\\.config\\.(ts|js|mjs|cjs)$",
  ],
  "solid-start": [
    "(^|/)src/routes/.+\\.(tsx|ts|jsx|js)$",
    "(^|/)src/entry-(server|client)\\.(tsx|ts|jsx|js)$",
    "(^|/)src/root\\.(tsx|ts|jsx|js)$",
  ],
  qwik: [
    "(^|/)src/routes/.+/(index|layout|plugin|service-worker|menu)\\.(tsx|ts)$",
    "(^|/)src/routes/.+\\.(tsx|ts)$",
    "(^|/)src/entry\\.(ssr|dev|preview|cloudflare-pages|express|fastify)\\.(tsx|ts)$",
    "(^|/)src/root\\.(tsx|ts)$",
  ],
};

const SCRIPT_RUNNER_RE = /\b(node|tsx|ts-node|tsm|vite-node|bun(?:\s+run)?|deno\s+run)\b/;
const SCRIPT_PATH_RE =
  /(?<!\S)((?:\.\/|\.\.\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+)(?=\s|['"]|$)/g;

export function collectEntryPoints(files: SourceFile[], rootDir: string): Set<string> {
  const entries = new Set<string>();
  for (const pkgDir of findPackageDirs(rootDir)) {
    addEntriesFromProjectConfig(entries, pkgDir, files);
  }
  addEntriesFromImports(entries, files);
  addEntriesFromTemplateFiles(entries, rootDir, files);
  addEntriesFromWorkspacePackageImports(entries, rootDir, files);
  addEntriesFromRegistryTsManifests(entries, rootDir, files);
  cascadeEntriesThroughBarrels(entries, files);
  return entries;
}

const REGISTRY_PATH_LITERAL_RE = /(?:^|[\s,{])path\s*:\s*["']([^"']+\.(?:tsx?|jsx?|mjs|cjs))["']/g;

function addEntriesFromRegistryTsManifests(
  entries: Set<string>,
  rootDir: string,
  files: SourceFile[],
): void {
  const manifests = safeGlob(rootDir, "**/{_registry,registry}.{ts,tsx,js,mjs}");
  if (manifests.length === 0) return;
  const filePathSet = new Set<string>();
  for (const sf of files) filePathSet.add(sf.getFilePath().replace(/\\/g, "/"));

  for (const manifestAbs of manifests) {
    if (PACKAGE_DIR_IGNORE.some((p) => manifestAbs.includes(p.replace(/\*\*/g, "")))) continue;
    let text: string;
    try {
      text = readFileSync(manifestAbs, "utf8");
    } catch (_err) {
      continue;
    }
    const norm = manifestAbs.replace(/\\/g, "/");
    const manifestDir = norm.slice(0, norm.lastIndexOf("/"));
    const parentDir = manifestDir.slice(0, manifestDir.lastIndexOf("/"));
    for (const m of text.matchAll(REGISTRY_PATH_LITERAL_RE)) {
      const rel = m[1];
      const candidates = [
        resolve(manifestDir, rel).replace(/\\/g, "/"),
        resolve(parentDir, rel).replace(/\\/g, "/"),
      ];
      for (const abs of candidates) {
        if (filePathSet.has(abs)) {
          entries.add(abs);
          break;
        }
      }
    }
  }
}

function addEntriesFromWorkspacePackageImports(
  entries: Set<string>,
  rootDir: string,
  files: SourceFile[],
): void {
  const packages = discoverWorkspacePackages(rootDir);
  if (packages.length === 0) return;

  const importedNames = new Set<string>();
  for (const sf of files) {
    for (const imp of sf.getImportDeclarations()) {
      const spec = safeGetSpecifierValue(imp);
      if (!spec || spec.startsWith(".")) continue;
      importedNames.add(spec);
      const slash = spec.lastIndexOf("/");
      if (spec.startsWith("@") && slash > 0) importedNames.add(spec.slice(0, slash));
      else if (slash > 0) importedNames.add(spec.slice(0, slash));
    }
    for (const exp of sf.getExportDeclarations()) {
      if (!exp.hasModuleSpecifier()) continue;
      const spec = safeGetSpecifierValue(exp);
      if (!spec || spec.startsWith(".")) continue;
      importedNames.add(spec);
    }
  }

  for (const pkg of packages) {
    if (!isPackageImported(pkg.name, importedNames)) continue;
    for (const sf of files) {
      const fp = sf.getFilePath().replace(/\\/g, "/");
      if (fp.startsWith(pkg.dir + "/")) entries.add(sf.getFilePath());
    }
  }
}

function isPackageImported(packageName: string, importedNames: Set<string>): boolean {
  if (importedNames.has(packageName)) return true;
  for (const imp of importedNames) {
    if (imp.startsWith(packageName + "/")) return true;
  }
  return false;
}

export function forEachDynamicImportTarget(
  sf: SourceFile,
  filesByPath: Map<string, SourceFile>,
  onTarget: (resolvedPath: string) => void,
): void {
  forEachStringLiteralCall(
    sf,
    (callee) =>
      callee.getKind() === SyntaxKind.ImportKeyword ||
      (Node.isIdentifier(callee) && callee.getText() === "require"),
    (spec) => {
      const resolved = resolveRelativeImport(sf, spec, filesByPath);
      if (resolved) onTarget(resolved);
    },
  );
}

function forEachStringLiteralCall(
  sf: SourceFile,
  calleeMatches: (callee: Node) => boolean,
  onSpec: (spec: string) => void,
): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!calleeMatches(call.getExpression())) continue;
    const args = call.getArguments();
    if (args.length === 0) continue;
    const first = args[0];
    if (!Node.isStringLiteral(first)) continue;
    onSpec(first.getLiteralValue());
  }
}

function findPackageDirs(rootDir: string): string[] {
  const matches = fg.sync("**/package.json", {
    cwd: rootDir,
    absolute: true,
    dot: false,
    onlyFiles: true,
    ignore: PACKAGE_DIR_IGNORE,
  });
  const dirs = new Set<string>();
  for (const match of matches) {
    dirs.add(match.replace(/\\/g, "/").slice(0, -"/package.json".length));
  }
  dirs.add(rootDir.replace(/\\/g, "/"));
  return [...dirs];
}

function resolveRelativeImport(
  fromFile: SourceFile,
  spec: string,
  filesByPath: Map<string, SourceFile>,
): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  return resolveSpecifierAgainstDir(fromFile.getDirectoryPath(), spec, filesByPath);
}

function addEntriesFromProjectConfig(
  entries: Set<string>,
  rootDir: string,
  files: SourceFile[],
): void {
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      addEntry(entries, rootDir, pkg.main);
      addEntry(entries, rootDir, pkg.module);
      addEntry(entries, rootDir, pkg.browser);
      if (typeof pkg.bin === "string") addEntry(entries, rootDir, pkg.bin);
      else if (pkg.bin && typeof pkg.bin === "object")
        for (const v of Object.values(pkg.bin))
          if (typeof v === "string") addEntry(entries, rootDir, v);
      collectExportsField(entries, rootDir, pkg.exports);
      collectScriptsEntries(entries, rootDir, pkg.scripts);
      collectFilesEntries(entries, rootDir, pkg.files);
    } catch (_err) {}
  }

  collectRegistryManifest(entries, rootDir);

  const detected = detectFrameworks(rootDir);
  const patterns = [...UNIVERSAL_ENTRY_PATTERNS];
  for (const fw of detected) patterns.push(...FRAMEWORK_ENTRY_PATTERNS[fw]);
  const re = new RegExp(patterns.join("|"));

  for (const sf of files) {
    const filePath = sf.getFilePath();
    if (re.test(relative(rootDir, filePath).replace(/\\/g, "/"))) entries.add(filePath);
  }
}

function cascadeEntriesThroughBarrels(entries: Set<string>, files: SourceFile[]): void {
  const filesByPath = new Map<string, SourceFile>();
  for (const sf of files) filesByPath.set(sf.getFilePath(), sf);

  const queue: string[] = [...entries];
  const seen = new Set<string>(queue);

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file) break;
    const sf = filesByPath.get(file);
    if (!sf) continue;
    for (const exp of sf.getExportDeclarations()) {
      const target = safeGetSpecifierSourceFile(exp);
      if (!target) continue;
      const targetPath = target.getFilePath();
      if (seen.has(targetPath)) continue;
      entries.add(targetPath);
      seen.add(targetPath);
      queue.push(targetPath);
    }
  }
}

const TEMPLATE_FILES_PATTERN = "**/*.{astro,vue,svelte,mdx,mdoc}";
const TEMPLATE_NAMED_IMPORT_RE = /import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
const TEMPLATE_BARE_IMPORT_RE = /import\s+['"]([^'"]+)['"]/g;

interface TemplateConsumption {
  fullFileConsumed: Set<string>;
  namedSymbolsByFile: Map<string, Set<string>>;
}

function addEntriesFromTemplateFiles(
  entries: Set<string>,
  rootDir: string,
  files: SourceFile[],
): void {
  const { fullFileConsumed } = collectTemplateConsumption(rootDir, files);
  for (const f of fullFileConsumed) entries.add(f);
}

export function collectTemplateConsumption(
  rootDir: string,
  files: SourceFile[],
): TemplateConsumption {
  const out: TemplateConsumption = {
    fullFileConsumed: new Set<string>(),
    namedSymbolsByFile: new Map<string, Set<string>>(),
  };
  const templates = safeGlob(rootDir, TEMPLATE_FILES_PATTERN);
  if (templates.length === 0) return out;

  const filesByPath = new Map<string, SourceFile>();
  for (const sf of files) filesByPath.set(sf.getFilePath().replace(/\\/g, "/"), sf);

  for (const templatePath of templates) {
    let content: string;
    try {
      content = readFileSync(templatePath, "utf8");
    } catch {
      continue;
    }
    const baseDir = templatePath.replace(/[\\/][^\\/]+$/, "");

    for (const match of content.matchAll(TEMPLATE_NAMED_IMPORT_RE)) {
      const clause = match[1].trim();
      const spec = match[2];
      if (!spec.startsWith(".")) continue;
      const resolved = resolveSpecifierAgainstDir(baseDir, spec, filesByPath);
      if (!resolved) continue;
      if (clause.startsWith("* ")) {
        out.fullFileConsumed.add(resolved);
        continue;
      }
      const names = parseImportClauseNames(clause);
      if (names.length === 0) continue;
      let set = out.namedSymbolsByFile.get(resolved);
      if (!set) {
        set = new Set();
        out.namedSymbolsByFile.set(resolved, set);
      }
      for (const n of names) set.add(n);
    }

    for (const match of content.matchAll(TEMPLATE_BARE_IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const resolved = resolveSpecifierAgainstDir(baseDir, spec, filesByPath);
      if (resolved) out.fullFileConsumed.add(resolved);
    }
  }
  return out;
}

function parseImportClauseNames(clause: string): string[] {
  const out: string[] = [];
  const stripped = clause.replace(/^(type|typeof)\s+/, "");
  const defaultMatch = stripped.match(/^([A-Za-z_$][\w$]*)/);
  if (defaultMatch) out.push(defaultMatch[1]);
  const namedBlock = stripped.match(/\{([^}]*)\}/);
  if (namedBlock) {
    for (const part of namedBlock[1].split(",")) {
      const trimmed = part.trim().replace(/^(type|typeof)\s+/, "");
      if (!trimmed) continue;
      const renamed = trimmed.split(/\s+as\s+/);
      const id = renamed[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) out.push(id);
    }
  }
  return out;
}

function resolveSpecifierAgainstDir(
  baseDir: string,
  spec: string,
  filesByPath: Map<string, SourceFile>,
): string | undefined {
  const noExt = spec.replace(/\.(js|mjs|cjs|jsx|tsx?|json)$/i, "");
  const candidates = [
    spec,
    `${noExt}.ts`,
    `${noExt}.tsx`,
    `${noExt}.js`,
    `${noExt}.jsx`,
    `${noExt}.mjs`,
    `${noExt}.cjs`,
    `${noExt}/index.ts`,
    `${noExt}/index.tsx`,
    `${noExt}/index.js`,
    `${noExt}/index.jsx`,
  ];
  for (const candidate of candidates) {
    const abs = resolve(baseDir, candidate).replace(/\\/g, "/");
    if (filesByPath.has(abs)) return abs;
  }
  return undefined;
}

function addEntriesFromImports(entries: Set<string>, files: SourceFile[]): void {
  const filesByPath = new Map<string, SourceFile>();
  for (const sf of files) filesByPath.set(sf.getFilePath(), sf);

  for (const sf of files) {
    for (const imp of sf.getImportDeclarations()) {
      const clause = imp.getImportClause();
      if (!clause) {
        const target = safeGetSpecifierSourceFile(imp);
        if (target) entries.add(target.getFilePath());
        continue;
      }
      if (clause.getNamespaceImport()) {
        const target = safeGetSpecifierSourceFile(imp);
        if (target) entries.add(target.getFilePath());
      }
    }
    forEachDynamicImportTarget(sf, filesByPath, (resolved) => entries.add(resolved));
  }
}

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PUBLISHED_DIR_IGNORE_EXTS = /\.(md|markdown|txt|json|yaml|yml|toml|lock|gitignore|npmignore)$/i;

function collectRegistryManifest(entries: Set<string>, rootDir: string): void {
  const manifestPath = join(rootDir, "registry.json");
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const items = manifest?.items;
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const files = item?.files;
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        const p = typeof file === "string" ? file : file?.path;
        if (typeof p === "string" && SOURCE_EXT_RE.test(p)) {
          addEntry(entries, rootDir, p);
        }
      }
    }
  } catch {
    return;
  }
}

function collectFilesEntries(entries: Set<string>, rootDir: string, filesField: unknown): void {
  if (!Array.isArray(filesField)) return;
  for (const item of filesField) {
    if (typeof item !== "string") continue;
    if (PUBLISHED_DIR_IGNORE_EXTS.test(item)) continue;
    if (item === "dist" || item.startsWith("dist/")) continue;
    if (item === "build" || item.startsWith("build/")) continue;

    if (SOURCE_EXT_RE.test(item)) {
      addEntry(entries, rootDir, item);
      continue;
    }
    if (item.includes("*")) {
      for (const m of safeGlob(rootDir, item)) {
        if (SOURCE_EXT_RE.test(m)) entries.add(m.replace(/\\/g, "/"));
      }
      continue;
    }
    for (const m of safeGlob(rootDir, `${item}/**/*.{ts,tsx,js,jsx,mjs,cjs}`)) {
      entries.add(m.replace(/\\/g, "/"));
    }
  }
}

function collectScriptsEntries(entries: Set<string>, rootDir: string, scripts: unknown): void {
  if (!scripts || typeof scripts !== "object") return;
  for (const value of Object.values(scripts as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (!SCRIPT_RUNNER_RE.test(value)) continue;
    for (const match of value.matchAll(SCRIPT_PATH_RE)) {
      addEntry(entries, rootDir, match[1]);
    }
  }
}

function addEntry(entries: Set<string>, rootDir: string, p: unknown): void {
  if (typeof p !== "string") return;
  for (const c of expandToSource(rootDir, p)) entries.add(c.replace(/\\/g, "/"));
}

function collectExportsField(entries: Set<string>, rootDir: string, exportsField: unknown): void {
  if (!exportsField) return;
  if (typeof exportsField === "string") {
    addEntry(entries, rootDir, exportsField);
    return;
  }
  if (typeof exportsField !== "object") return;
  for (const v of Object.values(exportsField as Record<string, unknown>)) {
    collectExportsField(entries, rootDir, v);
  }
}

function expandToSource(rootDir: string, target: string): string[] {
  if (target.includes("*")) return expandWildcardTarget(rootDir, target);

  const abs = isAbsolute(target) ? target : resolve(rootDir, target);
  const out: string[] = [abs];

  const distMatch = abs.match(/[\\/](dist|build|out)[\\/](.+)\.(js|mjs|cjs)$/);
  if (distMatch) {
    const tail = distMatch[2];
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      out.push(resolve(rootDir, "src", `${tail}.${ext}`));
      out.push(resolve(rootDir, `${tail}.${ext}`));
    }
  }

  if (/\.(js|mjs|cjs)$/.test(abs)) {
    out.push(abs.replace(/\.(js|mjs|cjs)$/, ".ts"));
    out.push(abs.replace(/\.(js|mjs|cjs)$/, ".tsx"));
  }

  if (!/\.[a-zA-Z0-9]+$/.test(abs)) {
    for (const ext of ["js", "ts", "tsx", "jsx", "mjs", "cjs"]) {
      out.push(`${abs}.${ext}`);
    }
  }
  return out;
}

function expandWildcardTarget(rootDir: string, target: string): string[] {
  const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "");
  const out = new Set<string>();

  for (const m of safeGlob(rootDir, normalized)) out.add(m);

  if (/\.(js|mjs|cjs|d\.ts)$/.test(normalized)) {
    const stem = normalized.replace(/\.(js|mjs|cjs|d\.ts)$/, "");
    const variants = `${stem}.{ts,tsx,jsx,js,mjs,cjs}`;
    for (const m of safeGlob(rootDir, variants)) out.add(m);
    for (const m of safeGlob(rootDir, `src/${variants}`)) out.add(m);
  }

  const distMatch = normalized.match(/^(dist|build|out)\/(.*)$/);
  if (distMatch) {
    const tail = distMatch[2].replace(/\.(js|mjs|cjs|d\.ts)$/, "");
    const wildcardTailTs = `${tail.replace(/\*/g, "**")}.{ts,tsx,js,jsx,mjs,cjs}`;
    for (const m of safeGlob(rootDir, `src/${wildcardTailTs}`)) out.add(m);
    for (const m of safeGlob(rootDir, wildcardTailTs)) out.add(m);
  }
  return [...out];
}

function safeGlob(rootDir: string, pattern: string): string[] {
  try {
    return fg.sync(pattern, {
      cwd: rootDir,
      absolute: true,
      onlyFiles: true,
      dot: false,
      ignore: PACKAGE_DIR_IGNORE,
      followSymbolicLinks: false,
    });
  } catch {
    return [];
  }
}
