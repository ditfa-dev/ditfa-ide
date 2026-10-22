/**
 * Copies the ts-rs generated app-server protocol types into packages/protocol/src/generated.
 *
 * The Rust crate is the source of truth: running
 *   cargo test -p ditfa-app-server-protocol
 * regenerates ditfa-rs/app-server-protocol/schema/typescript. This script mirrors
 * that output so the extension type-checks against the exact wire contract.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCHEMA = "ditfa-rs/app-server-protocol/schema/typescript";
// The engine lives in its own repository (ditfa-dev/ditfa-cli). Point DITFA_ENGINE_DIR at a checkout of it, or keep
// it next to this one.
const candidates = [process.env.DITFA_ENGINE_DIR, resolve(repoRoot, "../ditfa-cli"), resolve(repoRoot, "..")].filter(
  Boolean,
);
const engineDir = candidates.find((dir) => existsSync(resolve(dir, SCHEMA)));
const source = engineDir ? resolve(engineDir, SCHEMA) : resolve(candidates[0], SCHEMA);
const target = resolve(repoRoot, "packages/protocol/src/generated");

if (!engineDir) {
  console.error(`[sync-protocol] schema not found; looked in: ${candidates.join(", ")}`);
  console.error("[sync-protocol] set DITFA_ENGINE_DIR to a ditfa-cli checkout, then run there:");
  console.error("[sync-protocol]   cargo test -p ditfa-app-server-protocol");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

const repaired = repairRebrandedFilenames(target);
if (repaired.length > 0) {
  console.warn(
    `[sync-protocol] renamed ${repaired.length} file(s) whose name and exported type disagree: ${repaired.join(", ")}`,
  );
  console.warn(
    "[sync-protocol] this is an upstream bug — the ditfa rebrand renamed generated filenames but not the ts-rs type names or import paths",
  );
}

/**
 * The rebrand renamed some generated files without renaming the type
 * they export or the `import` paths that reference them, so the schema would
 * not type-check as shipped. Rename such files to match the type they export.
 */
function repairRebrandedFilenames(root) {
  const renamed = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name === "index.ts") {
        continue;
      }
      const declared = /export type (\w+)/.exec(readFileSync(path, "utf8"))?.[1];
      const stem = entry.name.slice(0, -3);
      if (declared && declared !== stem) {
        const next = join(dir, `${declared}.ts`);
        if (!existsSync(next)) {
          renameSync(path, next);
          renamed.push(`${stem} -> ${declared}`);
        }
      }
    }
  };
  walk(root);
  return renamed;
}

writeFileSync(
  resolve(target, "README.md"),
  [
    "# Generated protocol types",
    "",
    "Do not edit. Mirrored from `ditfa-rs/app-server-protocol/schema/typescript`",
    "by `pnpm run sync-protocol`.",
    "",
  ].join("\n"),
);

console.log(`[sync-protocol] copied protocol types to ${target}`);
