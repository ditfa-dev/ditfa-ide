import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = __dirname;

/** Mirrors the `@ditfa-ide/*` paths in tsconfig.base.json, so tests import modules exactly as the sources do. */
export default defineConfig({
  resolve: {
    alias: [
      // The real module only exists inside the extension host.
      { find: /^vscode$/, replacement: resolve(root, "apps/vscode/tests/stubs/vscode.ts") },
      { find: /^@ditfa-ide\/vscode\/(.*)$/, replacement: resolve(root, "apps/vscode/src") + "/$1" },
      { find: /^@ditfa-ide\/protocol$/, replacement: resolve(root, "packages/protocol/src/index.ts") },
      { find: /^@ditfa-ide\/protocol\/(.*)$/, replacement: resolve(root, "packages/protocol/src") + "/$1" },
      { find: /^@ditfa-ide\/contract$/, replacement: resolve(root, "packages/contract/src/index.ts") },
      { find: /^@ditfa-ide\/contract\/(.*)$/, replacement: resolve(root, "packages/contract/src") + "/$1" },
      { find: /^@ditfa-ide\/core$/, replacement: resolve(root, "packages/core/src/index.ts") },
      { find: /^@ditfa-ide\/core\/(.*)$/, replacement: resolve(root, "packages/core/src") + "/$1" },
      { find: /^@ditfa-ide\/cloud$/, replacement: resolve(root, "packages/cloud/src/index.ts") },
      { find: /^@ditfa-ide\/cloud\/(.*)$/, replacement: resolve(root, "packages/cloud/src") + "/$1" },
      { find: /^@ditfa-ide\/roundtable$/, replacement: resolve(root, "packages/roundtable/src/index.ts") },
      { find: /^@ditfa-ide\/roundtable\/(.*)$/, replacement: resolve(root, "packages/roundtable/src") + "/$1" },
      { find: /^@ditfa-ide\/webview$/, replacement: resolve(root, "packages/webview/src/main.ts") },
      { find: /^@ditfa-ide\/webview\/(.*)$/, replacement: resolve(root, "packages/webview/src") + "/$1" },
    ],
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
    environment: "node",
  },
});
