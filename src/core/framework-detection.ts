import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FrameworkName =
  | "next"
  | "sveltekit"
  | "astro"
  | "remix"
  | "nuxt"
  | "solid-start"
  | "qwik";

const FRAMEWORK_PACKAGES: Record<string, FrameworkName> = {
  next: "next",
  "@sveltejs/kit": "sveltekit",
  astro: "astro",
  "@remix-run/dev": "remix",
  "@remix-run/react": "remix",
  "@remix-run/node": "remix",
  "@remix-run/serve": "remix",
  nuxt: "nuxt",
  "solid-start": "solid-start",
  "@solidjs/start": "solid-start",
  "@builder.io/qwik": "qwik",
  "@builder.io/qwik-city": "qwik",
};

export function detectFrameworks(rootDir: string): Set<FrameworkName> {
  const out = new Set<FrameworkName>();
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return out;

  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return out;
  }
  if (!pkg || typeof pkg !== "object") return out;

  const merged: Record<string, unknown> = {};
  for (const field of ["dependencies", "devDependencies"] as const) {
    const section = (pkg as Record<string, unknown>)[field];
    if (section && typeof section === "object") {
      Object.assign(merged, section as Record<string, unknown>);
    }
  }

  for (const dep of Object.keys(merged)) {
    const framework = FRAMEWORK_PACKAGES[dep];
    if (framework) out.add(framework);
  }
  return out;
}
