// Detects whether the CartRules theme app blocks are placed in the store's
// live (MAIN) theme, by reading its template and section-group JSON
// (read_themes). App blocks appear there as
//   "type": "shopify://apps/<app>/blocks/<block-handle>/<uid>"
// and can be hidden with "disabled": true, which we treat as not installed.

const BLOCK_HANDLES = {
  productNotice: "cartrules-notice",
  cartGuard: "cartrules-cart-guard",
};

const TTL_MS = 30 * 1000;
const cache = new Map(); // shop -> { at, value }

function stripComment(content) {
  // Theme JSON files may start with a /* … */ auto-generated header.
  return content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
}

function findBlocks(node, handle, found = { enabled: false, disabled: false }) {
  if (!node || typeof node !== "object") return found;
  if (typeof node.type === "string" && node.type.includes(`/blocks/${handle}/`)) {
    if (node.disabled === true) found.disabled = true;
    else found.enabled = true;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") findBlocks(value, handle, found);
  }
  return found;
}

/**
 * { productNotice: "installed" | "disabled" | "missing" | "unknown",
 *   cartGuard: same, themeName }
 * "unknown" when the theme couldn't be read (e.g. read_themes not granted yet).
 */
export async function getThemeBlockStatus(admin, shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = { productNotice: "unknown", cartGuard: "unknown", themeName: null };
  try {
    const response = await admin.graphql(
      `#graphql
      query CartRulesThemeBlocks {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
            name
            files(filenames: ["templates/product*.json", "templates/cart*.json", "sections/*.json"], first: 250) {
              nodes {
                filename
                body { ... on OnlineStoreThemeFileBodyText { content } }
              }
            }
          }
        }
      }`,
    );
    const json = await response.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    const theme = json.data?.themes?.nodes?.[0];
    if (theme) {
      const result = {};
      for (const [key, handle] of Object.entries(BLOCK_HANDLES)) {
        const found = { enabled: false, disabled: false };
        for (const file of theme.files?.nodes ?? []) {
          const content = file.body?.content;
          if (!content || !content.includes(`/blocks/${handle}/`)) continue;
          try {
            findBlocks(JSON.parse(stripComment(content)), handle, found);
          } catch (_e) {
            // Unparseable file that mentions the block: count it as present.
            found.enabled = true;
          }
        }
        result[key] = found.enabled ? "installed" : found.disabled ? "disabled" : "missing";
      }
      value = { ...result, themeName: theme.name };
    }
  } catch (error) {
    console.warn("Could not read theme files for block detection", { shop, error: error?.message ?? String(error) });
  }
  cache.set(shop, { at: Date.now(), value });
  return value;
}
