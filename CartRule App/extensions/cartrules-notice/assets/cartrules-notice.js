/**
 * CartRules — client-side cart quantity guard (F5).
 *
 * Rules are keyed by product id, but themes don't put product ids on cart
 * quantity inputs — Dawn, for example, marks them with
 * data-quantity-line-key / data-quantity-variant-id / data-index. The cart
 * guard block (blocks/cartrules-cart-guard.liquid) therefore inlines a
 * key/variant/product map of cart.items, and each input is resolved to its
 * cart line through whichever of those markers the theme uses.
 *
 * Limits count every line of the same product together (two variants of one
 * product are 2 of that item), matching the checkout Function
 * (extensions/cartrules-validation) — which stays the real enforcement; this
 * script only corrects the quantity early and explains why.
 */
(function () {
  const dataEl = document.getElementById("cartrules-rules-data");
  if (!dataEl) return;

  let rules = [];
  let lines = [];
  try {
    const parsed = JSON.parse(dataEl.textContent || "{}");
    rules = (parsed.rules || []).filter(
      (r) => r.ruleType === "max_quantity" && r.maxQuantity && Array.isArray(r.productIds),
    );
    lines = JSON.parse(document.getElementById("cartrules-cart-lines")?.textContent || "[]");
  } catch (e) {
    return;
  }
  if (rules.length === 0) return;

  const messageEl = document.getElementById("cartrules-cart-message");
  let lineByKey = new Map();
  let lineByVariant = new Map();
  function setLines(next) {
    lines = next;
    lineByKey = new Map(lines.map((l) => [String(l.key), l]));
    lineByVariant = new Map(lines.map((l) => [String(l.variantId), l]));
  }
  setLines(lines);

  // The inlined map is rendered once with the page, but themes re-render only
  // their own cart section after an update — so a line added or removed on
  // the cart page (drawer, upsell) would be missing from it, or shift every
  // line position after it. Re-read the cart from the AJAX API instead.
  function reloadLines() {
    const root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    return fetch(`${root}cart.js`, { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((cart) => {
        if (!cart || !Array.isArray(cart.items)) return;
        setLines(
          cart.items.map((item) => ({ key: item.key, variantId: item.variant_id, productId: item.product_id })),
        );
      })
      .catch(() => {});
  }

  // syncRulesCache keeps only the most restrictive max_quantity rule per
  // product, so at most one rule matches.
  function ruleFor(productId) {
    return rules.find((r) => r.productIds.some((gid) => gid.endsWith(`/${productId}`))) || null;
  }

  function closestAttr(el, names) {
    for (let node = el; node && node.getAttribute; node = node.parentElement) {
      for (const name of names) {
        const value = node.getAttribute(name);
        if (value) return value;
      }
    }
    return null;
  }

  function lineFor(input) {
    const key =
      closestAttr(input, ["data-quantity-line-key", "data-line-key", "data-cart-item-key", "data-key"]) ||
      (input.id.startsWith("updates_") ? input.id.slice("updates_".length) : null);
    if (key && lineByKey.has(key)) return lineByKey.get(key);

    const variantId = closestAttr(input, ["data-quantity-variant-id", "data-variant-id"]);
    if (variantId && lineByVariant.has(variantId)) return lineByVariant.get(variantId);

    const productId = closestAttr(input, ["data-product-id"]);
    if (productId) return { key: null, productId };

    // 1-based line position (Dawn's data-index, older themes' data-line) —
    // only trustworthy while the page and the map list the same lines.
    if (quantityInputs().length !== lines.length) return null;
    const position = parseInt(input.getAttribute("data-index") || input.getAttribute("data-line") || "", 10);
    return lines[position - 1] || null;
  }

  function quantityInputs() {
    return Array.from(document.querySelectorAll('input[name="updates[]"]'));
  }

  // Quantity of the product's OTHER cart lines, read live from the page (the
  // inlined map's quantities go stale once the theme updates the cart).
  function otherLinesQuantity(input, line) {
    const counted = new Set(line.key ? [line.key] : []);
    let total = 0;
    for (const other of quantityInputs()) {
      if (other === input) continue;
      const otherLine = lineFor(other);
      if (!otherLine || String(otherLine.productId) !== String(line.productId)) continue;
      if (otherLine.key) {
        if (counted.has(otherLine.key)) continue;
        counted.add(otherLine.key);
      }
      total += parseInt(other.value, 10) || 0;
    }
    return total;
  }

  // Returns the rule message if this input is over its product's limit.
  function check(input, { clamp }) {
    const line = lineFor(input);
    if (!line) return null;
    const rule = ruleFor(line.productId);
    if (!rule) return null;
    const value = parseInt(input.value, 10);
    if (Number.isNaN(value) || value === 0) return null;

    const allowed = Math.max(1, rule.maxQuantity - otherLinesQuantity(input, line));
    if (value <= allowed) return null;
    if (clamp) input.value = String(allowed);
    return rule.message || `Maximum ${rule.maxQuantity} per order for this item.`;
  }

  // The last quantity this script lowered stays explained after the theme
  // re-renders the cart (by then the line is within its limit again).
  let lastCorrection = null;

  function showMessages(messages) {
    if (!messageEl) return;
    const text = Array.from(new Set([...messages, lastCorrection].filter(Boolean))).join(" ");
    // Only touch the DOM on a real change — the MutationObserver below would
    // otherwise re-trigger itself forever.
    if (messageEl.textContent !== text) messageEl.textContent = text;
    if (messageEl.hidden !== !text) messageEl.hidden = !text;
  }

  // Report any line already over its limit (e.g. added from the product page).
  function refresh() {
    showMessages(quantityInputs().map((input) => check(input, { clamp: false })));
  }

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.name !== "updates[]") return;
      // Capture phase: the value is corrected before the theme's own change
      // handler reads it, so the theme submits the allowed quantity.
      const message = check(target, { clamp: true });
      if (message) {
        lastCorrection = message;
        showMessages([]);
      }
    },
    true,
  );

  // Which cart rows the page currently shows — when this changes, lines were
  // added or removed and the map must be re-read before checking again.
  function rowsSignature() {
    return quantityInputs()
      .map((input) => closestAttr(input, ["data-quantity-line-key", "data-line-key", "data-cart-item-key", "data-key"]) || input.id)
      .join("|");
  }
  let lastRows = rowsSignature();

  // Themes re-render cart rows after every update; re-check once they settle.
  let pending = null;
  new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      const rows = rowsSignature();
      if (rows === lastRows) {
        pending = null;
        refresh();
        return;
      }
      lastRows = rows;
      reloadLines().then(() => {
        pending = null;
        refresh();
      });
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  refresh();
})();
