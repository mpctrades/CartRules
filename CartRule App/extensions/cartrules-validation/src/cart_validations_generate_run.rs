// cart.validations.generate.run — same behaviour as the JavaScript Function
// it replaces (engine/function.js): read the rules cache, evaluate the cart,
// block checkout with one error per distinct message.
use crate::engine::{self, get, js_string, lower_str, truthy, Cart, Line, LineData};
use crate::schema;
use crate::schema::run::input::cart::lines::Merchandise;
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;
use std::collections::{BTreeMap, HashSet};

const GENERIC_MESSAGE: &str = "Your cart doesn't meet this store's purchase rules.";

fn no_operations() -> Result<schema::CartValidationsGenerateRunResult> {
    Ok(schema::CartValidationsGenerateRunResult { operations: vec![] })
}

#[shopify_function]
fn cart_validations_generate_run(input: schema::run::Input) -> Result<schema::CartValidationsGenerateRunResult> {
    let Some(cache) = input.shop().metafield().map(|m| m.json_value()) else {
        return no_operations();
    };
    // if (!cache || cache.enabled === false) — `enabled` is the shop-wide
    // "CartRules protection" switch in Settings.
    if !truthy(Some(cache)) || matches!(get(cache, "enabled"), Some(JsonValue::Boolean(false))) {
        return no_operations();
    }
    let rules: Vec<JsonValue> = match get(cache, "rules") {
        Some(JsonValue::Array(rules)) => rules.iter().map(from_legacy).collect(),
        _ => vec![],
    };
    if rules.is_empty() {
        return no_operations();
    }

    let sources = line_sources(&input);
    let cart = to_engine_cart(&input, &sources);
    let violations = engine::evaluate_cart(&cart, &rules, get(cache, "conflictMode"));

    // Group limits never stop items going INTO the cart — the shopper keeps
    // everything they added and only payment is blocked (Update 1). Other
    // rule types keep blocking at add-to-cart as before.
    let at_cart = input.buyer_journey().step() == Some(&schema::BuyerJourneyStep::CartInteraction);

    // Settings → Storefront → "Checkout messages" off: one neutral message.
    let generic = matches!(get(cache, "checkoutMessagesEnabled"), Some(JsonValue::Boolean(false)));
    let generic_message = if truthy(get(cache, "genericMessage")) {
        js_string(get(cache, "genericMessage"))
    } else {
        GENERIC_MESSAGE.to_string()
    };

    let mut seen = HashSet::new();
    let mut errors = Vec::new();
    for v in violations {
        if at_cart && v.rule_type == "group_limit" {
            continue;
        }
        let message = if generic { generic_message.clone() } else { v.message };
        // One rule over several products would otherwise repeat the message.
        if message.is_empty() || !seen.insert(message.clone()) {
            continue;
        }
        errors.push(schema::ValidationError { message, target: "$.cart".to_string() });
    }
    if errors.is_empty() {
        return no_operations();
    }
    Ok(schema::CartValidationsGenerateRunResult {
        operations: vec![schema::Operation::ValidationAdd(schema::ValidationAddOperation { errors })],
    })
}

/// Caches written before rules v2 ({ ruleType, maxQuantity, productIds })
/// stay enforced until the app rewrites them on the merchant's next visit.
fn from_legacy(rule: &JsonValue) -> JsonValue {
    // if (!rule || rule.type || !rule.ruleType) return rule;
    if !truthy(Some(rule)) || truthy(get(rule, "type")) || !truthy(get(rule, "ruleType")) {
        return rule.clone();
    }
    let field = |k: &str| get(rule, k).cloned();
    let values = match get(rule, "productIds") {
        Some(JsonValue::Array(ids)) => JsonValue::Array(ids.clone()),
        _ => JsonValue::Array(vec![]),
    };
    let mut target = BTreeMap::new();
    target.insert("type".to_string(), JsonValue::String("product".to_string()));
    target.insert("values".to_string(), values);
    let mut out = BTreeMap::new();
    for (to, from) in [("id", "id"), ("type", "ruleType"), ("value", "maxQuantity"), ("msg", "message")] {
        if let Some(v) = field(from) {
            out.insert(to.to_string(), v);
        }
    }
    out.insert("target".to_string(), JsonValue::Object(target));
    JsonValue::Object(out)
}

type InputLine = schema::run::input::cart::Lines;
type InputVariant = schema::run::input::cart::lines::merchandise::ProductVariant;

/// A cart line read straight from the Function input, field by field.
struct Source<'a> {
    line: &'a InputLine,
    variant: &'a InputVariant,
}

impl LineData for Source<'_> {
    fn product_id(&self) -> &str {
        self.variant.product().id()
    }
    fn variant_id(&self) -> &str {
        self.variant.id()
    }
    fn title(&self) -> &str {
        self.variant.product().title()
    }
    fn vendor(&self) -> Option<&str> {
        self.variant.product().vendor().map(|v| v.as_str())
    }
    fn product_type(&self) -> Option<&str> {
        self.variant.product().product_type().map(|v| v.as_str())
    }
    fn tags(&self) -> Vec<String> {
        self.variant
            .product()
            .has_tags()
            .iter()
            .filter(|t| *t.has_tag())
            .map(|t| lower_str(&t.tag().to_lowercase()))
            .collect()
    }
    fn collections(&self) -> Vec<String> {
        self.variant
            .product()
            .in_collections()
            .iter()
            .filter(|c| *c.is_member())
            .map(|c| c.collection_id().clone())
            .collect()
    }
    fn subtotal(&self) -> f64 {
        or_zero(self.line.cost().subtotal_amount().amount().as_f64())
    }
    fn has_discount(&self) -> bool {
        !self.line.discount_allocations().is_empty()
    }
}

fn line_sources(input: &schema::run::Input) -> Vec<Source<'_>> {
    input
        .cart()
        .lines()
        .iter()
        .filter_map(|line| match line.merchandise() {
            Merchandise::ProductVariant(variant) => Some(Source { line, variant }),
            _ => None,
        })
        .collect()
}

fn to_engine_cart<'a>(input: &'a schema::run::Input, sources: &'a [Source<'a>]) -> Cart<'a> {
    let cart = input.cart();
    let lines = sources
        .iter()
        .map(|s| Line::new(s as &dyn LineData, *s.line.quantity() as f64))
        .collect();

    let buyer = cart.buyer_identity();
    let customer_tags = buyer
        .and_then(|b| b.customer())
        .map(|c| {
            c.has_tags()
                .iter()
                .filter(|t| *t.has_tag())
                .map(|t| lower_str(&t.tag().to_lowercase()))
                .collect()
        })
        .unwrap_or_default();
    let subtotal = cart.cost().subtotal_amount().amount().as_f64();
    Cart {
        lines,
        logged_in: buyer.map(|b| *b.is_authenticated()).unwrap_or(false),
        b2b: buyer
            .and_then(|b| b.purchasing_company())
            .map(|p| !p.company().id().is_empty())
            .unwrap_or(false),
        customer_tags,
        country: Some(input.localization().country().iso_code().to_string()),
        subtotal: if subtotal.is_finite() { subtotal } else { 0.0 },
        currency: Some(cart.cost().subtotal_amount().currency_code().to_string()),
    }
}

/// Number(x) || 0
fn or_zero(n: f64) -> f64 {
    if n.is_nan() {
        0.0
    } else {
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    fn messages(out: &schema::CartValidationsGenerateRunResult) -> Vec<String> {
        out.operations
            .iter()
            .flat_map(|op| match op {
                schema::Operation::ValidationAdd(add) => add.errors.iter().map(|e| e.message.clone()).collect::<Vec<_>>(),
            })
            .collect()
    }

    /// Replays the cases tests/function-parity.test.mjs recorded from the
    /// JavaScript Function: same input, same messages, same order.
    /// Each line: {"input": <Function input>, "expected": [messages]}.
    #[test]
    fn matches_javascript_function() -> Result<()> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/parity-cases.jsonl");
        let Ok(data) = std::fs::read_to_string(path) else {
            std::eprintln!("{path} missing — run: npm test (from CartRule App)");
            return Ok(());
        };
        let mut checked = 0;
        for (n, row) in data.lines().enumerate() {
            if row.trim().is_empty() {
                continue;
            }
            let case: serde_json::Value = serde_json::from_str(row)?;
            let input = case["input"].to_string();
            let want: Vec<String> = case["expected"]
                .as_array()
                .expect("expected array")
                .iter()
                .map(|m| m.as_str().expect("message string").to_string())
                .collect();
            let out = run_function_with_input(cart_validations_generate_run, &input)?;
            assert_eq!(messages(&out), want, "case {n}: {input}");
            checked += 1;
        }
        std::eprintln!("{checked} parity cases match");
        Ok(())
    }

    #[test]
    fn group_limit_blocks_checkout_not_cart() -> Result<()> {
        let rules = r#"{"v":2,"enabled":true,"rules":[{"id":"r1","type":"group_limit","value":2,"msg":"Max {{limit}} hoodies","target":{"type":"mixed","values":["tag:hoodie"]}}]}"#;
        let line = |n: u32, q: u32| {
            format!(
                r#"{{"quantity":{q},"cost":{{"subtotalAmount":{{"amount":"10.0"}}}},"discountAllocations":[],"merchandise":{{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/{n}","product":{{"id":"gid://shopify/Product/{n}","title":"Hoodie {n}","vendor":"V","productType":"T","hasTags":[{{"tag":"hoodie","hasTag":true}}],"inCollections":[]}}}}}}"#
            )
        };
        let input = |step: &str| {
            format!(
                r#"{{"buyerJourney":{{"step":"{step}"}},"cart":{{"lines":[{},{}],"cost":{{"subtotalAmount":{{"amount":"30.0","currencyCode":"USD"}}}},"buyerIdentity":null}},"localization":{{"country":{{"isoCode":"US"}}}},"shop":{{"metafield":{{"jsonValue":{rules}}}}}}}"#,
                line(1, 2),
                line(2, 1)
            )
        };
        let at_checkout = run_function_with_input(cart_validations_generate_run, &input("CHECKOUT_COMPLETION"))?;
        assert_eq!(messages(&at_checkout), vec!["Max 2 hoodies".to_string()]);
        let at_cart = run_function_with_input(cart_validations_generate_run, &input("CART_INTERACTION"))?;
        assert!(messages(&at_cart).is_empty());
        Ok(())
    }
}
