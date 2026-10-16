import { build, context } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

rmSync(resolve(here, "dist"), { recursive: true, force: true });

/** Every bundle resolves `@ditfa-ide/*` through the workspace paths in tsconfig.base.json. */
const shared = {
  bundle: true,
  tsconfig: resolve(root, "tsconfig.base.json"),
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  legalComments: "none",
};

/**
 * The extension host runs in Node and must not bundle the `vscode` module —
 * VS Code injects it at runtime.
 */
const extensionConfig = {
  ...shared,
  entryPoints: [resolve(here, "src/extension.ts")],
  outfile: resolve(here, "dist/extension.js"),
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
};

/**
 * The webview runs in a browser context with no Node APIs and a strict CSP,
 * so everything it needs must be inlined into a single IIFE bundle.
 */
const webviewConfig = {
  ...shared,
  entryPoints: [resolve(root, "packages/webview/src/main.ts")],
  outfile: resolve(here, "dist/webview.js"),
  platform: "browser",
  target: "es2022",
  format: "iife",
};

const styleConfig = {
  ...shared,
  entryPoints: [resolve(root, "packages/webview/src/styles.css")],
  outfile: resolve(here, "dist/webview.css"),
};

const configs = [extensionConfig, webviewConfig, styleConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("[esbuild] watching…");
} else {
  await Promise.all(configs.map((config) => build(config)));
  console.log(`[esbuild] built (${production ? "production" : "development"})`);
}
