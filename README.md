# @findai/slp · `slp`

Static analysis for JS/TS that finds the slop AI generators (and humans) leave behind: dead exports, near-duplicate code, empty wrappers, useless type predicates, structural look-alikes, orphan files, gratuitous `async`, and empty `catch` blocks.

Zero config. Safe `--fix` with diff preview and rollback. Confidence scores so you can triage by signal strength.

```bash
npx @findai/slp
```

> Findings are signals, not verdicts. Treat every line in the output as a hypothesis to verify — open the file, read the surrounding code, decide for yourself. Static analysis can't tell intent from shape alone. A high-confidence "dead export" might be your public API; a "structural duplicate" might be parallel-by-design.

---

## What it finds

### Dead code

Exports nothing imports. Entry points are auto-detected: `package.json` `main` / `bin` / `module` / `exports` (including `*` wildcards), Next.js / Astro / SvelteKit / Remix / Nuxt / SolidStart / Qwik conventions, plus generic tool configs (Vite, Webpack, Rollup, ESLint, Prettier, Vitest, Playwright, Tailwind, PostCSS, and more). Reachability follows ES `import`, dynamic `import()`, CommonJS `require()`, and consumers inside `.astro` / `.vue` / `.svelte` templates.

### Unused exports

Symbols exported but only used within their own file. The `export` keyword is redundant — flagged separately from dead code so you can act on each tier.

### Duplicate code

Two-pass detection:

- **Window-sliding hash** finds near-identical token sequences across files (≥50 tokens). Identifiers and literals are normalized so renamed copies still match.
- **AST-structural** compares function bodies by their syntax-kind sequence. Catches AI-generated CRUD repetition where every entity has the same shape with different names.

Pairs that share any location are coalesced into one cluster via union-find. A block copy-pasted across three or more files becomes a single issue with all match locations, not N redundant pairs.

### Empty wrappers

Functions whose entire body is `return otherFn(args)` with identical arguments. Also catches the two-statement form `const x = otherFn(args); return x;` (the intermediate variable adds no semantics), the type-assertion form `return otherFn(args) as Foo;`, and the JSX pass-through pattern `function W(props) { return <Inner {...props} /> }` (including the destructured-rest form `function W({...rest}) { return <Inner {...rest} /> }`).

Skipped: type-predicate functions (`x is Foo`), hook wrappers (`useCallback` / `useMemo`), method overrides and interface implementations, fluent-API factories (`z.object({}).partial()`), decorated methods, generic functions (`<T extends ...>`), typed variable aliases, zero-arg thunks (`() => x.method()`), regex predicates, `this`-rooted call chains, factory-returned object methods, `@deprecated` JSDoc, Next.js route handlers.

### AI signatures

- **Useless type predicates** — `function isStr(x): x is string { return typeof x === 'string' }` collapses to a bare `typeof` check because TS narrows on `typeof` / `instanceof` / `Array.isArray` / nullish checks natively.
- **Same-shape types** — multiple interfaces or type aliases with identical fields in different files. AI generators often emit a fresh type per consumer instead of reusing one.

### Code smells

- **Useless async** — `async function foo() { return x }` with no `await`, no `for await`, no `Promise.X(...)` return, and no explicit `Promise<...>` return type. The `async` keyword adds nothing.
- **Empty catch** — `try { ... } catch {}` or `catch (e) {}` with an empty block, plus `catch (e) { throw e; }` (pure rethrow — removing the try/catch behaves identically). `catch {}` (no parameter) reported with higher confidence; documented intent via `catch (_)`, comment inside the block, or trailing same-line comment is exempt.

### Insights

Cross-detector observations rolled up into single findings:

- `scaffold-folder` — 3+ unused files under `components/ui/` (shadcn-ui scaffold).
- `orphaned-file` — file not reachable from any entry point.
- `dead-wrapper-chain` — a wrapper that is itself dead.
- `dead-duplicate-pair` — two identical functions both unused.
- `wrapper-only-file` — file where most top-level exports are pass-throughs.
- `over-abstraction-chain` — 3+ levels of `a -> b -> c -> realThing`.

---

## Quickstart

```bash
npx @findai/slp                       # whole project
npx @findai/slp src/                  # one folder
npx @findai/slp --fix                 # diff preview, confirm, then write
npx @findai/slp --min-confidence 0.8  # hide low-confidence findings
npx @findai/slp --json                # machine-readable
```

Example output:

```
slp v0.1.0  ·  scanning .

  INSIGHTS
    0.80 scaffold-folder       components/ui  shadcn-ui scaffold — 26 unused components
    0.90 orphaned-file         lib/supabase/client.ts  1 unused export: createClient
    0.90 orphaned-file         types/error-response.ts  2 unused exports: ErrorResponse, ErrorResponseSchema

  db/limits.ts
    0.90 9        dead    PROFILE_BIO_MAX              exported but never imported
    0.90 10       dead    WORKSPACE_NAME_MAX           exported but never imported

  components/ui/use-toast.ts
    0.75 140      unused  toast                        only used in this file (61 local uses)

  components/sidebar/items/all/sidebar-update-item.tsx
    0.92 135-153  dup     block                        87% similar to components/utility/global-state.tsx:39

  components/icons/anthropic-svg.tsx
    0.80 3        shape   AnthropicSVGProps            AnthropicSVGProps / GoogleSVGProps / OpenAISVGProps share 3-field shape

  3 insights  ·  6 issues  ·  262 files  ·  5.6s
  → --fix removes 2 dead-code items
  verify each finding — confidence is a hint, not a verdict
```

Each line shows confidence (green ≥ 0.80, yellow 0.50–0.80, dim below), line range, detector kind, symbol name, and a brief description.

---

## CLI

```
slp [options] [paths...]

  --fix                Remove dead-code items (diff preview + TS verify before write)
  --json               Machine-readable JSON output
  --only <detector>    duplicates | dead-code | empty-wrappers | ai-signatures | code-smells
  --ignore <glob...>   Extra ignore patterns
  --min-confidence <n> Hide findings with confidence below n (0..1, default 0.7)
  --verbose            Show single-detector issues that were rolled up into insights
  --no-color           Disable ANSI colors
  -y, --yes            Skip --fix confirmation
  -v, --version        Show version
  -h, --help           Show help
```

### Exit codes

| Code | Meaning                |
|------|------------------------|
| `0`  | nothing flagged        |
| `1`  | issues or insights     |
| `2`  | unexpected error       |

### `--fix` safety

1. Builds a diff plan — the exact source lines that will be removed, grouped by file.
2. Prints it and asks for confirmation (`-y` skips).
3. Snapshots every affected source file in memory, applies removals via the TypeScript AST (formatting preserved), runs ts-morph diagnostics.
4. If a new `Cannot find name 'X'` / `Module has no exported member 'X'` references a removed symbol, **rolls back the whole batch** and reports which references would have broken. Nothing reaches disk.

Same-file references are caught reliably; cross-file is partially covered — see [Known limitations](#known-limitations).

---

## Comparison

| | slp | knip | ts-prune | jscpd |
|---|---|---|---|---|
| Dead exports | yes | yes | yes | — |
| Duplicate code | yes (AST-aware) | — | — | yes |
| Empty wrappers | yes | — | — | — |
| Type-predicate / shape detection | yes | — | — | — |
| Cross-detector insights | yes | — | — | — |
| `--fix` with rollback | yes | partial | — | — |
| Confidence scoring | yes | — | — | — |
| Plugin system | — | yes (40+) | — | — |
| Monorepo workspaces | yes (per-package, beta) | yes | — | partial |
| Zero config | yes | yes | partial | partial |

slp and knip are complementary. knip has more plugins and deeper framework coverage. slp finds patterns knip doesn't (duplicates, AI signatures) and packages them with confidence scores and cross-detector insights.

---

## Programmatic API

```ts
import { scan, scanMonorepo, applyDeadCodeFixes } from "@findai/slp";

const result = await scan({ rootDir: process.cwd() });
console.log(`${result.issues.length} issues, ${result.insights.length} insights`);

const dead = result.issues.filter((i) => i.kind === "dead-code");
const fix = await applyDeadCodeFixes(result.project, dead);
if (fix.rolledBack) {
  console.error("Rolled back. Would have broken:", fix.brokenBy);
}
```

### Monorepo support (beta)

For monorepos, use `scanMonorepo()` (the CLI uses it automatically when a workspace root is detected):

```ts
import { scanMonorepo } from "@findai/slp";
const result = await scanMonorepo({ rootDir: process.cwd() });
```

`scanMonorepo` discovers workspaces from `package.json#workspaces` and `pnpm-workspace.yaml`, scans each workspace package as its own `ts-morph` Project (so per-package `tsconfig#paths` resolve correctly), and uses a project-wide pre-pass of `@scope/foo` imports to keep cross-package consumed symbols alive in their declaring package.

**Cross-package resolution:**

- **Named imports** (`import { foo } from "@scope/x"`) — symbol-level. Only `foo` is treated as consumed; other exports of `@scope/x` stay open to dead-code analysis.
- **Default imports** (`import X from "@scope/x"`) — the target package's entry file is parsed for `export default function Name`, `export default class Name`, or `export default Identifier`. The resolved name is added to consumed symbols. Anonymous defaults (`export default () => ...`) fall back to package-level "everything consumed."
- **Namespace imports** (`import * as A from "@scope/x"`) — the consumer file is scanned for `A.member` accesses; each member becomes a consumed symbol. Dynamic access patterns (`A[someVar]`) trigger package-level fallback.
- **Star re-exports** (`export * from "@scope/x"`) — package-level consumption (the re-exporter forwards every export downstream).
- **Subpath imports** (`import { foo } from "@scope/x/deep"`) — the dead-code detector's alias-tail fallback matches when the declaration's file path ends with the subpath.

**Why beta:**

- `tsconfig#references` is not yet honored cross-package — projects that use TypeScript project references in lieu of workspace imports may show false positives until this is added.
- `--fix` runs per-package; if removing a dead symbol in `@scope/foo` would break a reference in `@scope/bar`, the cross-package break is not part of the rollback verification.
- Subpath import resolution uses textual matching, not the package's `exports` field — packages that aggressively remap subpaths through `exports` may need explicit verification.

Treat workspace-package findings as starting points and verify the surrounding code before acting.

---

## How it works

| Step | Approach |
|---|---|
| File discovery | `fast-glob` + `.gitignore` + default ignores |
| Parsing | TypeScript compiler via `ts-morph` |
| Symbol cache | Single-pass identifier → references map, shared across detectors |
| Entry points | `package.json` fields (incl. `exports` wildcards), framework conventions, ES / dynamic / CommonJS / template imports |
| Duplicates | FNV-1a rolling hash + AST structural fingerprint, clipped to function bodies |
| `--fix` verify | ts-morph diagnostics; new `Cannot find name` errors trigger rollback |

---

## Known limitations

- **Cross-file rollback on `--fix`** is partial. We keep `skipFileDependencyResolution: true` for scan speed; this trades some cross-file diagnostic precision during the post-removal verify. Same-file rollback works reliably.
- **String-literal paths** in build scripts (`require(somePath)` where `somePath` is computed) are not followed. Such files may surface as orphans.
- **Monorepo (beta)** — cross-package resolution is per-symbol for named, default, and namespace imports (with documented fallbacks for anonymous default exports, dynamic namespace access, and `export * from` re-exports). `tsconfig#references` is not yet honored cross-package, and `--fix` rollback verification runs per-package (a removed symbol that breaks a reference in a sibling package will not be caught). See [Monorepo support](#monorepo-support-beta).
- **JS files** (`.js` / `.jsx` / `.cjs` / `.mjs`) are scanned for dead code only if your `tsconfig.json` enables `allowJs` (or there is no tsconfig — slp then defaults to `allowJs: true`). Mixed TS projects with `allowJs: false` will skip JS files in dead-code analysis.

---

## License

MIT

---

<sub>AI-assisted</sub>

