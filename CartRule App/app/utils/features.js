// Client-safe feature switches (not *.server.js — route components read these).
//
// ORDER_ACTIVITY_ENABLED gates every screen fed by the RuleEvent table: the
// Overview KPI cards / activity chart / recent activity, the Activity page,
// the Rules table's Activity column, and Billing's "Usage this month". The
// only writer of RuleEvent rows is the orders/create webhook, which stays
// disabled in shopify.app.toml until Protected Customer Data access is
// approved — so with this on, those screens could only ever show zeros and
// "activity will appear here" copy that never comes true (App Store
// requirement 1.1.4, factual information). To turn activity back on:
// re-enable the orders/create webhook and read_orders scope in
// shopify.app.toml (and SCOPES in .env), deploy, then set this to true.
export const ORDER_ACTIVITY_ENABLED = false;
