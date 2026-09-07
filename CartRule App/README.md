# CartRules

> "Some products should never be discounted, and some should never be bought by the dozen. CartRules enforces both, automatically."

CartRules is a small Shopify app. A merchant creates rules attached to products, collections, or tags. Version 1 has exactly two rule types:

- **No discount** — the product is excluded from discount codes (protects margin on new releases, already-discounted items, fixed-price licensed goods).
- **Max quantity** — a customer can buy at most N units of the product per order (protects shipping margin on bulky/heavy items, and stops resellers emptying limited-edition stock).

This document is the guide for anyone on the dev team picking up this project. Read it fully once, then read it again before touching code. If something here doesn't match what you find in the code, trust the code and fix this file.

---

## 1. Two questions everyone asks first

### "Why Remix + Node?"

That's the stack specified in the project brief (section 06): "Admin app — Shopify Remix app template (Node.js), Polaris UI." It's also what this app is built with.

One thing worth knowing: Shopify's own CLI (`npm init @shopify/app@latest`) now scaffolds a **React Router 7** app by default — Shopify quietly moved their official template off Remix after this brief was written. React Router 7 and Remix 2 are extremely close (React Router 7 is Remix's direct successor, built by the same team, using almost the same APIs), but they are not identical, and the brief explicitly says Remix. So this codebase was **hand-authored on classic Remix 2** (`@remix-run/*` + `@shopify/shopify-app-remix`, which still exists and is maintained) instead of running the CLI's default scaffold. If the team would rather ride Shopify's currently-recommended path, migrating to React Router 7 later is a small, mechanical change (mostly import renames) — see section 9.

### "Does this app need a database?"

**No, not for the app's actual data.** Every rule a merchant creates is stored as a **Shopify metaobject** living inside their own store (see section 5). That's a deliberate choice, not a shortcut:

- The merchant's data stays in the merchant's store. Uninstalling the app doesn't strand orphaned rows in a database we'd have to pay to host and manage.
- No database migrations, no backups, no GDPR data-export headache for "what data do you hold on me" — Shopify already handles all of that for metaobjects.

There **is** one small SQLite file (`prisma/schema.prisma`, a single `Session` table) — that's required by every embedded Shopify app to store OAuth session tokens between requests. It holds zero business data, only login sessions. See `app/db.server.js`. In production this would typically move to a small persistent volume or a managed session storage adapter (Shopify publishes adapters for Redis, PostgreSQL, MongoDB, etc.) — SQLite is fine for development and for a single small VPS deployment (the brief's plan, section 06: "Hosting — Our VPS").

---

## 2. Project structure

```
CartRule App/
├── README.md                        ← this file
├── package.json                     ← dependencies + npm scripts
├── shopify.app.toml                 ← app config: scopes, webhooks, URLs (placeholders until API keys arrive)
├── .env.example                     ← copy to .env and fill in real values
├── vite.config.js                   ← Remix + Vite dev server config
├── prisma/
│   └── schema.prisma                ← ONE table: OAuth sessions. Not for app data — see section 1.
├── app/                             ← the Remix admin app (what the merchant sees embedded in Shopify admin)
│   ├── entry.server.jsx             ← Remix server entry (boilerplate)
│   ├── entry.client.jsx             ← Remix client hydration entry (boilerplate)
│   ├── root.jsx                     ← root HTML document
│   ├── shopify.server.js            ← THE central config: API keys, scopes, billing plans, webhooks
│   ├── db.server.js                 ← Prisma client (sessions only)
│   ├── models/
│   │   └── rules.server.js          ← ALL rule CRUD + the checkout-cache sync. Read this file first.
│   └── routes/
│       ├── _index.jsx               ← handles Shopify's install/open redirect
│       ├── auth.$.jsx                ← OAuth callback catch-all
│       ├── app.jsx                   ← embedded app shell (nav menu, Polaris provider)
│       ├── app._index.jsx            ← Dashboard: rule list, F4 (mockup Screen 1)
│       ├── app.rules.new.jsx         ← 3-step rule creator, F1/F2/F3 (mockup Screen 2)
│       ├── app.rules.$id.jsx         ← Edit an existing rule
│       ├── app.billing.jsx           ← Free / Growth / Pro plan picker
│       ├── webhooks.app.uninstalled.jsx
│       ├── webhooks.app.scopes_update.jsx
│       ├── webhooks.customers.data_request.jsx  ← GDPR: no-op, we hold no customer data
│       ├── webhooks.customers.redact.jsx        ← GDPR: no-op, we hold no customer data
│       └── webhooks.shop.redact.jsx             ← GDPR: defensive session cleanup
└── extensions/
    ├── cartrules-validation/        ← Shopify Function: the actual checkout enforcement
    │   ├── shopify.extension.toml
    │   ├── package.json
    │   └── src/
    │       ├── cart_validations_generate_run.graphql   ← what data the Function reads (custom path, wired via input_query in the .toml)
    │       └── index.js                                 ← the enforcement logic itself — MUST be named index.js/.ts, the CLI hardcodes this as the entry point
    └── cartrules-notice/             ← OPTIONAL theme app extension (brief calls it optional)
        ├── shopify.extension.toml
        ├── blocks/
        │   ├── cartrules-notice.liquid       ← "max N per order" notice on the product page
        │   └── cartrules-cart-guard.liquid   ← inlines rules JSON on the cart page
        └── assets/
            └── cartrules-notice.js           ← client-side quantity auto-adjust, F5
```

---

## 3. How a rule actually works, end to end

This is the part worth understanding before changing anything.

1. **Merchant fills out the 3-step wizard** (`app/routes/app.rules.new.jsx`): rule type → target (tag/collection/product) → message.
2. **Saving creates a metaobject** (`app/models/rules.server.js` → `createRule`). The metaobject type is `cartrules_rule`, defined once per shop by `ensureMetaobjectDefinition` on first use. This metaobject is the merchant-facing source of truth — it's what the Dashboard (`app._index.jsx`) reads and lists.
3. **Every write also rebuilds a cache** (`syncRulesCache`): it reads every ACTIVE rule, resolves collection targets down to a flat list of product IDs (a Shopify Function's input query can't cheaply walk collection membership itself), and writes the whole thing as one JSON blob into a **shop-level metafield**: namespace `cartrules`, key `rules_cache`.
4. **At checkout, the Shopify Function runs** (`extensions/cartrules-validation`). Its only input is that one metafield (see the `.graphql` file) — it never talks to the metaobjects directly. For every cart line, it checks max-quantity rules (does quantity exceed the cap?) and no-discount rules (does this line have any discount allocation?), and returns a validation error with the merchant's own message when a rule is violated. Shopify blocks checkout and shows that message, matching mockup Screen 3.
5. **Optionally**, the theme app extension reads the same cached metafield client-side (via Liquid's storefront access) to show an early warning on the product page and soft-clamp quantity in the cart — but the Function in step 4 is what actually enforces the rule; the theme extension is UX polish only, per the brief ("Customer is corrected politely, not blocked with a mystery error").

**Known limitation, flagged on purpose**: if a merchant adds a product to an already-targeted collection, the cache won't reflect that until the next rule save (whichever rule gets edited next re-triggers `syncRulesCache`, but nothing currently re-triggers it on a plain product/collection edit). Fixing this properly means adding `products/update` and `collections/update` webhooks that re-run `syncRulesCache`. Not built in v1 — see the TODO comment directly above `expandCollectionToProductIds` in `rules.server.js`.

---

## 4. Setup

1. **Install dependencies**
   ```
   cd "CartRule App"
   npm install
   ```

2. **Create a Partner app and dev store** (once the team has Partner access):
   ```
   shopify app config link
   ```
   This walks you through picking/creating an app in the Partner Dashboard and writes the real `client_id` into `shopify.app.toml`, replacing the `REPLACE_WITH_PARTNER_APP_CLIENT_ID` placeholder.

3. **Copy the env file** and fill in the real API key/secret from the Partner Dashboard's "Client credentials" tab:
   ```
   cp .env.example .env
   ```

4. **Run the dev server**:
   ```
   shopify app dev
   ```
   This starts a tunnel, installs the app on your dev store, runs the Remix app, and watches the Function/theme extensions for changes. The CLI will prompt you to select the dev store the first time.

5. **Generate Function types** (once linked, inside the extension folder) to catch API mismatches early:
   ```
   cd extensions/cartrules-validation && npm run typegen
   ```
   Compare the generated types against the assumptions documented at the top of `extensions/cartrules-validation/src/index.js` — flagged there as `TODO(verify)` because the Functions API has changed shape across Shopify API versions before.

6. **Deploy extensions** (Function + theme extension) to the Partner app when ready:
   ```
   shopify app deploy
   ```

---

## 5. Testing checklist (from the brief's "Definition of done", section 10)

Go through all of these on a dev store loaded with realistic MPC-style products (a bulky plush, a fixed-price special edition) before calling any milestone done:

- [ ] A merchant can create their **first working rule in under 3 minutes**, no docs needed — time yourself doing the 3-step wizard cold.
- [ ] A max-quantity limit holds on the **cart page**, at **checkout**, and when the customer **edits quantity after adding to cart**.
- [ ] An excluded product **never receives a discount** in this exact test matrix:
  - [ ] discount code applied directly to the excluded product,
  - [ ] mixed cart (excluded + non-excluded product) with a code applied,
  - [ ] code applied first, excluded product added to cart afterward.
- [ ] Customer messages render correctly in **French** and **Japanese** (accents, non-Latin characters) — type real FR/JP text into Step 3 of the wizard and check the checkout error text.
- [ ] App is **approved on the Shopify App Store**, Free + paid plans are live, and the first **10 installs and 3 reviews land within 30 days** of launch.

---

## 6. 8-week roadmap, mapped to this codebase

From the brief (section 09), restated against what's actually in this repo so progress is checkable:

| Weeks | Brief goal | What that means here |
|---|---|---|
| 1–2 | Spikes proven; hard-coded max-2 rule blocks checkout | Get `extensions/cartrules-validation` deployed and manually verified against a hard-coded `rules_cache` value on a dev store — this is Demo 1. |
| 3–4 | 3-step creator working for both rule types; metaobjects; pause/activate | `app/routes/app.rules.new.jsx`, `app/models/rules.server.js`, `app/routes/app._index.jsx` — wire the wizard's placeholder product/collection text fields to a real App Bridge `ResourcePicker` (flagged as a TODO in `app.rules.new.jsx`). This is Demo 2. |
| 5–6 | Custom messages, tag/collection targeting, cart auto-adjust, Polaris polish | `extensions/cartrules-notice`, plus real testing per section 5's checklist on real MPC products. This is Demo 3. |
| 7–8 | Billing, App Store listing, review checklist, submission | `app/routes/app.billing.jsx` is scaffolded — needs real testing against `billing.request`/`billing.check`. Then the App Store checklist below. This is Demo 4. |

---

## 7. Shopify App Store submission checklist

- [ ] App listing screenshots — reuse/refine the three brief mockups (Dashboard, 3-step wizard, customer-facing cart/checkout messages) as real screenshots from a live dev store.
- [ ] Listing copy: short description, long description, the one-sentence pitch from the brief, category (Store management → Cart/checkout).
- [ ] Pricing page matching `app/routes/app.billing.jsx`: Free (3 rules), Growth ($4.99/mo), Pro ($9.99/mo) — no transaction fees, flat price, matching the brief's positioning against MinMaxify/AOD/Limitsify.
- [ ] Privacy policy URL (required for every listed app) — MPC Trades needs to provide/host this; it's not something this codebase generates.
- [x] GDPR mandatory webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) — registered in `shopify.app.toml` under `compliance_topics`, handled in `app/routes/webhooks.customers.data_request.jsx`, `webhooks.customers.redact.jsx`, `webhooks.shop.redact.jsx`. All three are no-ops beyond logging + a defensive session cleanup, because CartRules never stores customer-identifying data anywhere — see the comment at the top of each file.
- [ ] App review requirements: working demo/dev store credentials for Shopify's reviewers, and a support email/contact.
- [ ] Confirm billing works end-to-end on a real (non-test) charge before flipping `isTest` off in `app/routes/app.billing.jsx`.

---

## 8. TODO once the real API keys and Partner access arrive

Everything below is a placeholder — search the codebase for these if grepping is faster:

- `shopify.app.toml`: `client_id`, `application_url`, and the three `redirect_urls` — all say `REPLACE_WITH_...`. Fixed automatically by running `shopify app config link`.
- `.env` (create from `.env.example`): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`.
- `extensions/cartrules-validation/shopify.extension.toml` and the `.graphql`/`.js` files inside it: marked `TODO(verify)` — re-check against `npm run typegen` output once a real Partner app is linked, since the Functions API shape has moved before.
- `app/routes/app.rules.new.jsx`: the free-text product/collection fields are a placeholder for a real App Bridge `ResourcePicker` — swap once you're building against a live store with real products to pick from.
- Collection-membership staleness (section 3's "known limitation") — add `products/update`/`collections/update` webhooks if it turns out to matter in practice.

---

## 9. If the team later wants to switch to React Router 7

Not needed now, but worth knowing the path exists: `@shopify/shopify-app-remix` has a companion `@shopify/shopify-app-react-router` package, and the route/loader/action API is nearly identical. The bulk of the work would be renaming `@remix-run/*` imports to `react-router`/`@react-router/*` equivalents and switching `vite.config.js`'s Remix plugin for the React Router one. `app/models/rules.server.js` (the actual business logic) wouldn't need to change at all — it doesn't import anything Remix-specific.
