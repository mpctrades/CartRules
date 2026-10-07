// Copies the shared rule engine into the theme app extension's assets, so the
// storefront blocks run exactly the logic the checkout Function runs.
// `npm run sync-engine` writes it; `npm run sync-engine -- --check` fails if
// the copy is stale (run in CI / before deploy).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SRC = "extensions/cartrules-validation/src/engine.js";
const DEST = "extensions/cartrules-notice/assets/cartrules-engine.js";
const header = `// GENERATED from ${SRC} by scripts/sync-engine.mjs — do not edit.\n`;
const expected = header + readFileSync(SRC, "utf8");

if (process.argv.includes("--check")) {
  if (!existsSync(DEST) || readFileSync(DEST, "utf8") !== expected) {
    console.error(`${DEST} is out of date — run: npm run sync-engine`);
    process.exit(1);
  }
  console.log("Storefront engine copy is up to date.");
} else {
  writeFileSync(DEST, expected);
  console.log(`Wrote ${DEST}`);
}
