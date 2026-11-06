// Copies the shared rule engine (the checkout Function's source of truth)
// to where the other runtimes load it, so all of them run exactly the logic
// the Function runs:
//   - the theme app extension's assets (storefront blocks)
//   - app/models/ruleEngine.generated.js (admin: rule form, simulator, cache).
//     The admin can't import from extensions/ directly: `shopify app dev`'s
//     proxy reserves /extensions/* URLs, so the browser could never load it.
// `npm run sync-engine` writes them; `npm run sync-engine -- --check` fails
// if a copy is stale (run in CI / before build and deploy).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SRC = "extensions/cartrules-validation/src/engine.js";
const DESTS = [
  "extensions/cartrules-notice/assets/cartrules-engine.js",
  "app/models/ruleEngine.generated.js",
];
const header = `// GENERATED from ${SRC} by scripts/sync-engine.mjs — do not edit.\n`;
const expected = header + readFileSync(SRC, "utf8");

if (process.argv.includes("--check")) {
  const stale = DESTS.filter((d) => !existsSync(d) || readFileSync(d, "utf8") !== expected);
  if (stale.length) {
    console.error(`${stale.join(", ")} out of date — run: npm run sync-engine`);
    process.exit(1);
  }
  console.log("Engine copies are up to date.");
} else {
  for (const d of DESTS) {
    writeFileSync(d, expected);
    console.log(`Wrote ${d}`);
  }
}
