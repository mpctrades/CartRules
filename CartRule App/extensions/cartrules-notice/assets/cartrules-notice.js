/**
 * CartRules storefront script (ES module) for both theme blocks:
 *  - Product rule notice (blocks/cartrules-notice.liquid): shows the rules
 *    that apply to this product for this shopper, and lowers a quantity
 *    above a maximum before it's added to the cart.
 *  - Cart quantity guard (blocks/cartrules-cart-guard.liquid): explains
 *    every rule the cart breaks and lowers quantities above a maximum.
 *
 * Rule decisions come from cartrules-engine.js — a generated copy of the
 * checkout Function's engine — so the storefront and checkout always agree.
 * The checkout Function stays the real enforcement.
 *
 * When a shopper hits a rule, the script reports it (rule id, product id,
 * quantities — no customer data) to /apps/cartrules/events, which feeds
 * the merchant's Activity and Analytics pages.
 */

const PRODUCT_LEVEL_TYPES = ["max_quantity", "min_quantity", "quantity_multiple", "no_discount", "product_combination"];

function readJson(root, selector, fallback) {
  try {
    const el = root.querySelector(selector);
    return el ? JSON.parse(el.textContent || "null") ?? fallback : fallback;
  } catch (_e) {
    return fallback;
  }
}

const lower = (list) => (list || []).map((t) => String(t).toLowerCase());

function routesRoot() {
  return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
}

// ---- Activity reporting ----------------------------------------------------

const reported = new Set();
function report(root, cartToken, events) {
  if (root.hasAttribute("data-design-mode") || (window.Shopify && window.Shopify.designMode)) return;
  const fresh = events.filter((e) => {
    const key = `${e.ruleId}|${e.productId}|${e.attempted}|${e.where}`;
    if (reported.has(key)) return false;
    reported.add(key);
    return true;
  });
  if (fresh.length === 0) return;
  try {
    fetch("/apps/cartrules/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cartToken: cartToken || null, events: fresh }),
      keepalive: true,
    }).catch(() => {});
  } catch (_e) {
    // Reporting must never affect the storefront.
  }
}

const toEvent = (v, where) => ({
  ruleId: v.ruleId,
  ruleType: v.type,
  productId: v.productId,
  productTitle: v.productTitle,
  attempted: v.attempted,
  allowed: v.allowed,
  where,
});

// ---- Product page ----------------------------------------------------------

function initProductNotice(root, engine) {
  const cache = readJson(root, "[data-cartrules-rules]", { rules: [] });
  const product = readJson(root, "[data-cartrules-product]", null);
  const context = readJson(root, "[data-cartrules-context]", {});
  if (!product) return;
  const rules = (cache.rules || []).filter((r) => PRODUCT_LEVEL_TYPES.includes(r.type));
  const messagesEl = root.querySelector("[data-cartrules-messages]");
  const placeholder = root.querySelector("[data-cartrules-placeholder]");
  const ctx = { customer: { ...(context.customer || {}), tags: lower(context.customer && context.customer.tags) }, country: context.country };

  function currentVariantId() {
    const fromUrl = new URLSearchParams(window.location.search).get("variant");
    if (fromUrl) return Number(fromUrl);
    const input = document.querySelector('form[action*="/cart/add"] [name="id"]');
    return input && input.value ? Number(input.value) : product.variantId;
  }

  function line(quantity) {
    return {
      productId: `gid://shopify/Product/${product.productId}`,
      variantId: `gid://shopify/ProductVariant/${currentVariantId()}`,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: lower(product.tags),
      collections: product.collections || [],
      quantity: quantity || 1,
      subtotal: 0,
      hasDiscount: false,
    };
  }

  function render() {
    const applicable = rules.filter((r) => engine.ruleAppliesToProduct(r, line(1), ctx));
    const texts = Array.from(
      new Set(
        applicable.map((r) =>
          engine.renderMessage(r.msg, { type: r.type, product: product.title, limit: r.value, collection: r.targetLabel }),
        ),
      ),
    );
    messagesEl.replaceChildren(
      ...texts.map((text) => {
        const div = document.createElement("div");
        div.className = "cartrules-notice";
        div.style.cssText =
          "padding:0.75rem 1rem;margin:1rem 0;border-radius:0.5rem;border:1px solid rgba(var(--color-foreground,18,18,18),0.25);";
        div.textContent = text;
        return div;
      }),
    );
    if (placeholder) placeholder.hidden = texts.length > 0;
  }

  // Quantity above a maximum: lower it before the shopper adds to cart.
  document.addEventListener(
    "change",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.name !== "quantity") return;
      if (!input.closest('form[action*="/cart/add"], product-info, .product, [data-product-form]') && !input.form) return;
      const qty = parseInt(input.value, 10);
      if (!(qty > 0)) return;
      const cart = { lines: [line(qty)], customer: ctx.customer, country: ctx.country, subtotal: NaN };
      const { violations } = engine.evaluateCart(cart, rules, { conflictMode: cache.conflictMode });
      const max = violations.find((v) => v.type === "max_quantity");
      if (!max) return;
      input.value = String(max.allowed);
      report(root, null, [toEvent(max, "product")]);
    },
    true,
  );
  document.addEventListener("change", (event) => {
    if (event.target && event.target.name === "id") render();
  });
  window.addEventListener("popstate", render);
  render();
}

// ---- Cart page -------------------------------------------------------------

function initCartGuard(root, engine) {
  const cache = readJson(root, "[data-cartrules-rules]", { rules: [] });
  const rules = cache.rules || [];
  if (rules.length === 0) return;
  const context = readJson(root, "[data-cartrules-context]", {});
  const ctx = { customer: { ...(context.customer || {}), tags: lower(context.customer && context.customer.tags) }, country: context.country };
  const messagesEl = root.querySelector("[data-cartrules-messages]");
  let cartData = readJson(root, "[data-cartrules-cart]", { lines: [] });
  let lastCorrection = null;

  const quantityInputs = () => Array.from(document.querySelectorAll('input[name="updates[]"]'));

  function closestAttr(el, names) {
    for (let node = el; node && node.getAttribute; node = node.parentElement) {
      for (const name of names) {
        const value = node.getAttribute(name);
        if (value) return value;
      }
    }
    return null;
  }

  // Themes mark cart inputs by line key, variant id or 1-based position.
  function lineFor(input) {
    const key =
      closestAttr(input, ["data-quantity-line-key", "data-line-key", "data-cart-item-key", "data-key"]) ||
      (input.id.startsWith("updates_") ? input.id.slice("updates_".length) : null);
    const lines = cartData.lines || [];
    if (key) {
      const byKey = lines.find((l) => String(l.key) === key);
      if (byKey) return byKey;
    }
    const variantId = closestAttr(input, ["data-quantity-variant-id", "data-variant-id"]);
    if (variantId) {
      const byVariant = lines.find((l) => String(l.variantId) === variantId);
      if (byVariant) return byVariant;
    }
    if (quantityInputs().length !== lines.length) return null;
    const position = parseInt(input.getAttribute("data-index") || input.getAttribute("data-line") || "", 10);
    return lines[position - 1] || null;
  }

  // The cart as the page shows it right now (input values may be ahead of the inlined cart).
  function engineCart() {
    const quantities = new Map();
    for (const input of quantityInputs()) {
      const l = lineFor(input);
      if (l) quantities.set(String(l.key), parseInt(input.value, 10) || 0);
    }
    const lines = (cartData.lines || []).map((l) => {
      const quantity = quantities.has(String(l.key)) ? quantities.get(String(l.key)) : l.quantity;
      return {
        key: l.key,
        productId: `gid://shopify/Product/${l.productId}`,
        variantId: `gid://shopify/ProductVariant/${l.variantId}`,
        title: l.title,
        vendor: l.vendor,
        productType: l.productType,
        tags: lower(l.tags),
        collections: l.collections || [],
        quantity,
        subtotal: Math.round((Number(l.unitPrice) || 0) * quantity * 100) / 100,
        hasDiscount: Boolean(l.hasDiscount),
      };
    });
    return {
      lines: lines.filter((l) => l.quantity > 0),
      customer: ctx.customer,
      country: ctx.country,
      subtotal: Math.round(lines.reduce((s, l) => s + l.subtotal, 0) * 100) / 100,
      currency: cartData.currency || null,
      discountCode: cartData.discountCode || null,
    };
  }

  function evaluate() {
    return engine.evaluateCart(engineCart(), rules, { conflictMode: cache.conflictMode }).violations;
  }

  function show(violations) {
    if (!messagesEl) return;
    const text = Array.from(new Set([...violations.map((v) => v.message), lastCorrection].filter(Boolean))).join(" ");
    // Only touch the DOM on a real change — the MutationObserver below would
    // otherwise re-trigger itself forever.
    if (messagesEl.textContent !== text) messagesEl.textContent = text;
    if (messagesEl.hidden !== !text) messagesEl.hidden = !text;
  }

  function refresh() {
    const violations = evaluate();
    show(violations);
    report(root, cartData.token, violations.map((v) => toEvent(v, "cart")));
  }

  // Capture phase: correct the value before the theme's own handler submits it.
  document.addEventListener(
    "change",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.name !== "updates[]") return;
      const line = lineFor(input);
      if (!line) return;
      const value = parseInt(input.value, 10) || 0;
      if (value === 0) return;
      const productId = `gid://shopify/Product/${line.productId}`;
      const variantId = `gid://shopify/ProductVariant/${line.variantId}`;
      const max = evaluate().find(
        (v) => v.type === "max_quantity" && (v.productId === productId || v.productId === variantId),
      );
      if (!max) return;
      // Other lines of the same product count toward the same limit.
      const others = max.attempted - value;
      const allowed = max.allowed - others;
      // Other lines already use the whole limit: nothing valid to clamp to.
      if (allowed >= 1) input.value = String(allowed);
      lastCorrection = max.message;
      report(root, cartData.token, [toEvent(max, "cart")]);
      show(evaluate());
    },
    true,
  );

  // After the theme updates the cart, re-render this section to read the
  // fresh cart (new lines need their tags and collections).
  let reloading = null;
  function reloadCart() {
    const sectionId = root.getAttribute("data-section-id");
    if (!sectionId) return Promise.resolve();
    if (reloading) return reloading;
    reloading = fetch(`${routesRoot()}cart?sections=${encodeURIComponent(sectionId)}`, {
      headers: { Accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const html = data && data[sectionId];
        if (!html) return;
        const doc = new DOMParser().parseFromString(html, "text/html");
        const next = readJson(doc, "[data-cartrules-cart]", null);
        if (next) cartData = next;
      })
      .catch(() => {})
      .finally(() => {
        reloading = null;
      });
    return reloading;
  }

  const rowsSignature = () =>
    quantityInputs()
      .map((i) => `${closestAttr(i, ["data-quantity-line-key", "data-line-key", "data-cart-item-key", "data-key"]) || i.id}:${i.value}`)
      .join("|");
  let lastRows = rowsSignature();
  let pending = null;
  new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      const rows = rowsSignature();
      if (rows === lastRows) {
        pending = null;
        return;
      }
      lastRows = rows;
      reloadCart().then(() => {
        pending = null;
        refresh();
      });
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  refresh();
}

// ---- Boot ------------------------------------------------------------------

const roots = [
  ...document.querySelectorAll("[data-cartrules-product-notice], [data-cartrules-cart-guard]"),
].filter((el) => !el.__cartrulesInit);
if (roots.length) {
  const engineUrl = roots[0].getAttribute("data-engine-url");
  import(engineUrl)
    .then((engine) => {
      for (const root of roots) {
        root.__cartrulesInit = true;
        try {
          if (root.hasAttribute("data-cartrules-product-notice")) initProductNotice(root, engine);
          else initCartGuard(root, engine);
        } catch (error) {
          console.warn("CartRules:", error);
        }
      }
    })
    .catch((error) => console.warn("CartRules: could not load rule engine", error));
}
