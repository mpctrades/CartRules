/**
 * CartRules — client-side cart quantity guard (F5).
 *
 * TODO(theme-specific): this is best-effort scaffolding that could not be
 * tested against a real theme (no dev store connected yet). Every Shopify
 * theme markets up cart quantity inputs differently. It assumes:
 *   - each cart line row has `[data-cartrules-line-item-id]` OR falls back
 *     to matching by product id embedded in `input[name="updates[]"]`'s
 *     nearest `[data-product-id]` ancestor — themes vary, adjust selectors
 *     for the merchant's actual theme before relying on this in production.
 *   - the FINAL enforcement is always the checkout Function
 *     (extensions/cartrules-validation) — this script is a UX nicety
 *     ("politely corrected", per the brief), never the source of truth.
 */
(function () {
  const dataEl = document.getElementById("cartrules-rules-data");
  if (!dataEl) return;

  let rules = [];
  try {
    const parsed = JSON.parse(dataEl.textContent || "{}");
    rules = (parsed.rules || []).filter((r) => r.ruleType === "max_quantity");
  } catch (e) {
    return;
  }
  if (rules.length === 0) return;

  function maxFor(productId, tags) {
    for (const rule of rules) {
      if (rule.matchType === "product_id" && rule.productIds?.some((gid) => gid.endsWith(`/${productId}`))) {
        return rule;
      }
      if (rule.matchType === "tag" && tags?.includes(rule.tag)) {
        return rule;
      }
    }
    return null;
  }

  function showNotice(input, message) {
    let notice = input.parentElement.querySelector(".cartrules-cart-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "cartrules-cart-notice";
      notice.style.color = "#8a0000";
      notice.style.fontSize = "0.85em";
      notice.style.marginTop = "4px";
      input.parentElement.appendChild(notice);
    }
    notice.textContent = message;
  }

  function clampInput(input) {
    const productId = input.closest("[data-product-id]")?.getAttribute("data-product-id");
    const tags = (input.closest("[data-product-tags]")?.getAttribute("data-product-tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!productId) return;

    const rule = maxFor(productId, tags);
    if (!rule || !rule.maxQuantity) return;

    const value = parseInt(input.value, 10);
    if (!Number.isNaN(value) && value > rule.maxQuantity) {
      input.value = String(rule.maxQuantity);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      showNotice(input, rule.message || `Maximum ${rule.maxQuantity} per order for this item.`);
    }
  }

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.name === "updates[]") {
        clampInput(target);
      }
    },
    true,
  );
})();
