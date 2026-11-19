// CartRules — Cart and Checkout Validation Function (Rust).
//
// Target: cart.validations.generate.run
// Docs: https://shopify.dev/docs/api/functions/latest/cart-and-checkout-validation
//
// Rules come from the `cartrules.rules_cache` shop metafield (a `json`
// metafield, read as `jsonValue`), which the admin app rebuilds on every
// rule or settings change (buildRulesCache in app/models/rules.server.js).
//
// `engine.rs` is a port of engine/engine.js — the rule logic the admin
// simulator and the storefront blocks run. The two must give the same answer
// for every cart: tests/function-parity.test.mjs + `cargo test` check that.
//
// Why Rust: the JavaScript build ran inside an interpreter where every
// string op or object allocation cost thousands of instructions, so big
// carts went over Shopify's 11M-instruction limit
// (InstructionCountLimitExceededError on ma-petite-coree, Nov 2026).
use shopify_function::prelude::*;
use std::process;

pub mod cart_validations_generate_run;
pub mod engine;

#[typegen("./schema.graphql")]
pub mod schema {
    #[query("src/cart_validations_generate_run.graphql")]
    pub mod run {}
}

fn main() {
    log!("Please invoke a named export.");
    process::abort();
}
