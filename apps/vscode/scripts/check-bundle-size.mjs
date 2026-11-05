/**
 * Fails the build when a bundle outgrows its budget.
 *
 * Panels that take seconds to boot or run out of memory get there one
 * dependency at a time, so the budget is enforced rather than remembered.
 */
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

const BUDGETS = {
  // +60 KB in 0.7.0 for the device bridge: `ws` (~48 KB) and the terminal tools.
  "extension.js": 345_000,
  // +10 KB JS and +6 KB CSS for the round table's team run card, start sheet and code review findings.
  "webview.js": 120_000,
  "webview.css": 60_000,
  "settings.js": 70_000,
  "settings.css": 28_000,
};

let failed = false;
for (const [file, limit] of Object.entries(BUDGETS)) {
  const size = statSync(resolve(DIST, file)).size;
  const over = size > limit;
  failed ||= over;
  console.log(`${over ? "FAIL" : "ok  "} ${file} ${size} / ${limit} bytes`);
}
process.exit(failed ? 1 : 0);
