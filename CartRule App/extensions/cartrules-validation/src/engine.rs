// Port of engine/engine.js (evaluateCart and everything it calls) for the
// checkout Function. Only `violations` are computed — the Function never
// needed `matches` (the admin simulator's view).
//
// The rules arrive as the parsed `rules_cache` JSON, so every place the
// JavaScript engine leans on JS coercion (Number(), String(), truthiness,
// toFixed) does the same here through the `js_*` helpers. Behaviour must stay
// identical to engine.js: tests/function-parity.test.mjs builds randomized carts,
// records the JavaScript answers, and `cargo test` replays them against this
// code.

use shopify_function::scalars::JsonValue;
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

/// FxHash (rustc's hasher): far cheaper than the default SipHash inside the
/// Wasm sandbox, where every instruction counts toward the 11M limit. The
/// keys are IDs and tags, not attacker-chosen in any way that matters here.
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);

impl Hasher for Fx {
    fn write(&mut self, bytes: &[u8]) {
        const K: u64 = 0x51_7c_c1_b7_27_22_0a_95;
        let mut chunks = bytes.chunks_exact(8);
        for c in &mut chunks {
            let word = u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]);
            self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(K);
        }
        for &b in chunks.remainder() {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(K);
        }
    }
    fn write_u8(&mut self, i: u8) {
        self.0 = (self.0.rotate_left(5) ^ i as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_usize(&mut self, i: usize) {
        self.0 = (self.0.rotate_left(5) ^ i as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

pub type FxSet<T> = HashSet<T, BuildHasherDefault<Fx>>;
pub type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;

// ---------------------------------------------------------------------------
// JavaScript coercion helpers

pub fn get<'a>(v: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match v {
        JsonValue::Object(map) => map.get(key),
        _ => None,
    }
}

/// JS truthiness. `None` is `undefined`.
pub fn truthy(v: Option<&JsonValue>) -> bool {
    match v {
        None | Some(JsonValue::Null) => false,
        Some(JsonValue::Boolean(b)) => *b,
        Some(JsonValue::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(JsonValue::String(s)) => !s.is_empty(),
        Some(JsonValue::Array(_)) | Some(JsonValue::Object(_)) => true,
    }
}

fn is_nullish(v: Option<&JsonValue>) -> bool {
    matches!(v, None | Some(JsonValue::Null))
}

/// Number#toString for the values that reach messages and IDs.
pub fn js_num_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        return format!("{:.0}", n);
    }
    // Shortest round-trip digits, like JS (exponent forms differ only for
    // values no rule or cart produces).
    format!("{}", n)
}

/// String(value). `None` (undefined) gives "undefined", as in JS.
pub fn js_string(v: Option<&JsonValue>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(JsonValue::Null) => "null".to_string(),
        Some(JsonValue::Boolean(b)) => b.to_string(),
        Some(JsonValue::Number(n)) => js_num_to_string(*n),
        Some(JsonValue::String(s)) => s.clone(),
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| if matches!(item, JsonValue::Null) { String::new() } else { js_string(Some(item)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(JsonValue::Object(_)) => "[object Object]".to_string(),
    }
}

/// String(value == null ? "" : value)
fn js_string_or_empty(v: Option<&JsonValue>) -> String {
    if is_nullish(v) {
        String::new()
    } else {
        js_string(v)
    }
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// Number(string)
pub fn js_str_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let lower = t.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut n = 0f64;
            for c in digits.chars() {
                match c.to_digit(radix) {
                    Some(d) => n = n * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return n;
        }
    }
    // Rust accepts a few spellings JS doesn't ("inf", "nan", "infinity").
    let body = lower.trim_start_matches(['+', '-']);
    if body.starts_with("inf") || body.starts_with("nan") {
        return f64::NAN;
    }
    // JS rejects "1_0", Rust too; both accept "1.", ".5", "1e3".
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Number(value). `None` (undefined) is NaN.
pub fn js_number(v: Option<&JsonValue>) -> f64 {
    match v {
        None => f64::NAN,
        Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Boolean(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(JsonValue::Number(n)) => *n,
        Some(JsonValue::String(s)) => js_str_to_number(s),
        Some(JsonValue::Array(items)) => match items.len() {
            0 => 0.0,
            1 => js_str_to_number(&js_string_or_empty(Some(&items[0]))),
            _ => f64::NAN,
        },
        Some(JsonValue::Object(_)) => f64::NAN,
    }
}

/// Number#toFixed(2) (ties round away from zero, like JS).
pub fn js_to_fixed2(x: f64) -> String {
    if !x.is_finite() {
        return js_num_to_string(x);
    }
    if x.abs() >= 1e21 {
        return js_num_to_string(x);
    }
    let negative = x < 0.0;
    let m = x.abs();
    let scaled = m * 100.0;
    let n = if scaled.fract() == 0.5 { scaled.floor() + 1.0 } else { return fixed_via_format(x) };
    let whole = (n / 100.0).floor();
    let cents = n - whole * 100.0;
    let text = format!("{:.0}.{:02.0}", whole, cents);
    if negative && n != 0.0 {
        format!("-{}", text)
    } else {
        text
    }
}

fn fixed_via_format(x: f64) -> String {
    let s = format!("{:.2}", x);
    if s == "-0.00" && x == 0.0 {
        "0.00".to_string()
    } else {
        s
    }
}

/// lower() in engine.js: String(value == null ? "" : value).trim().toLowerCase()
pub fn lower(v: Option<&JsonValue>) -> String {
    lower_str(&js_string_or_empty(v))
}

pub fn lower_str(s: &str) -> String {
    js_trim(s).to_lowercase()
}

/// numericId(): the part after the last "/" of String(gid == null ? "" : gid).
pub fn numeric_id(v: Option<&JsonValue>) -> String {
    numeric_id_str(&js_string_or_empty(v)).to_string()
}

pub fn numeric_id_str(s: &str) -> &str {
    match s.rfind('/') {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

fn array(v: Option<&JsonValue>) -> Option<&Vec<JsonValue>> {
    match v {
        Some(JsonValue::Array(items)) => Some(items),
        _ => None,
    }
}

fn str_of(v: Option<&JsonValue>) -> Option<&str> {
    match v {
        Some(JsonValue::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Cart

/// One cart line as the Function input holds it. Reads are lazy: each field
/// is only pulled from the input when a rule needs it — reading the input is
/// most of what a big cart costs.
pub trait LineData {
    fn product_id(&self) -> &str;
    fn variant_id(&self) -> &str;
    fn title(&self) -> &str;
    fn vendor(&self) -> Option<&str>;
    fn product_type(&self) -> Option<&str>;
    /// Tags the product has, each lowercased (as the JavaScript Function's
    /// input does) and then lower()-ed again as engine.js's lowerSet does.
    fn tags(&self) -> Vec<String>;
    /// GIDs of the selected collections the product is in.
    fn collections(&self) -> Vec<String>;
    fn subtotal(&self) -> f64;
    fn has_discount(&self) -> bool;
}

pub struct Line<'a> {
    src: &'a dyn LineData,
    pub quantity: f64,
    tags: OnceCell<Vec<String>>,
    collections: OnceCell<Vec<String>>,
}

impl<'a> Line<'a> {
    pub fn new(src: &'a dyn LineData, quantity: f64) -> Self {
        Line { src, quantity, tags: OnceCell::new(), collections: OnceCell::new() }
    }
    pub fn product_id(&self) -> &str {
        self.src.product_id()
    }
    pub fn variant_id(&self) -> &str {
        self.src.variant_id()
    }
    pub fn title(&self) -> &str {
        self.src.title()
    }
    pub fn vendor(&self) -> Option<&str> {
        self.src.vendor()
    }
    pub fn product_type(&self) -> Option<&str> {
        self.src.product_type()
    }
    pub fn tags(&self) -> &[String] {
        self.tags.get_or_init(|| self.src.tags())
    }
    pub fn collections(&self) -> &[String] {
        self.collections.get_or_init(|| self.src.collections())
    }
    pub fn subtotal(&self) -> f64 {
        self.src.subtotal()
    }
    pub fn has_discount(&self) -> bool {
        self.src.has_discount()
    }
}

pub struct Cart<'a> {
    pub lines: Vec<Line<'a>>,
    pub logged_in: bool,
    pub b2b: bool,
    /// Lowercased, then trimmed (lowerSet keys).
    pub customer_tags: Vec<String>,
    pub country: Option<String>,
    pub subtotal: f64,
    pub currency: Option<String>,
}

// ---------------------------------------------------------------------------
// Targets

enum Target {
    All,
    Product(FxSet<String>),
    Variant(FxSet<String>),
    Collection(FxSet<String>),
    Tag(FxSet<String>),
    Vendor(FxSet<String>),
    ProductType(FxSet<String>),
    Mixed {
        product: FxSet<String>,
        collection: FxSet<String>,
        tag: FxSet<String>,
    },
    Never,
}

fn values_of(target: Option<&JsonValue>) -> &[JsonValue] {
    // (target && target.values) || [] — non-array values iterate as nothing.
    if !truthy(target) {
        return &[];
    }
    match target.and_then(|t| get(t, "values")) {
        Some(JsonValue::Array(items)) => items.as_slice(),
        _ => &[],
    }
}

fn compile_target(target: Option<&JsonValue>) -> Target {
    // target && target.type ? target.type : "all"
    let type_value = if truthy(target) { target.and_then(|t| get(t, "type")) } else { None };
    if !truthy(type_value) {
        return Target::All;
    }
    let kind = match type_value {
        Some(JsonValue::String(s)) => s.as_str(),
        _ => return Target::Never,
    };
    let values = values_of(target);
    let lower_set = || values.iter().map(|v| lower(Some(v))).collect::<FxSet<_>>();
    let id_set = || values.iter().map(|v| numeric_id(Some(v))).collect::<FxSet<_>>();
    match kind {
        "all" => Target::All,
        "product" => Target::Product(id_set()),
        "variant" => Target::Variant(id_set()),
        // new Set(values): only string values can equal a collection GID.
        "collection" => Target::Collection(
            values
                .iter()
                .filter_map(|v| match v {
                    JsonValue::String(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
        ),
        "tag" => Target::Tag(lower_set()),
        "vendor" => Target::Vendor(lower_set()),
        "product_type" => Target::ProductType(lower_set()),
        "mixed" => {
            let mut product = FxSet::default();
            let mut collection = FxSet::default();
            let mut tag = FxSet::default();
            for raw in values {
                let v = js_string_or_empty(Some(raw));
                let Some(i) = v.find(':') else { continue };
                let (kind, rest) = (&v[..i], &v[i + 1..]);
                match kind {
                    "product" => {
                        product.insert(numeric_id_str(rest).to_string());
                    }
                    "collection" => {
                        collection.insert(rest.to_string());
                    }
                    "tag" => {
                        tag.insert(lower_str(rest));
                    }
                    _ => {}
                }
            }
            Target::Mixed { product, collection, tag }
        }
        _ => Target::Never,
    }
}

fn any_in(set: &FxSet<String>, items: &[String]) -> bool {
    !set.is_empty() && items.iter().any(|x| set.contains(x))
}

fn line_matches(target: &Target, line: &Line) -> bool {
    match target {
        Target::All => true,
        Target::Product(set) => !set.is_empty() && set.contains(numeric_id_str(line.product_id())),
        Target::Variant(set) => !set.is_empty() && set.contains(numeric_id_str(line.variant_id())),
        Target::Collection(set) => any_in(set, line.collections()),
        Target::Tag(set) => any_in(set, line.tags()),
        Target::Vendor(set) => set.contains(&lower_str(line.vendor().unwrap_or(""))),
        Target::ProductType(set) => set.contains(&lower_str(line.product_type().unwrap_or(""))),
        Target::Mixed { product, collection, tag } => {
            (!product.is_empty() && product.contains(numeric_id_str(line.product_id())))
                || (!collection.is_empty() && any_in(collection, line.collections()))
                || (!tag.is_empty() && any_in(tag, line.tags()))
        }
        Target::Never => false,
    }
}

// ---------------------------------------------------------------------------
// Conditions

fn line_conditions_pass(line: &Line, conditions: &[JsonValue]) -> bool {
    for c in conditions {
        let field = str_of(get(c, "field"));
        let value = get(c, "value");
        let hit = match field {
            Some("product_tag") => {
                let want = lower(value);
                line.tags().iter().any(|t| *t == want)
            }
            Some("product_vendor") => lower_str(line.vendor().unwrap_or("")) == lower(value),
            Some("product_type") => lower_str(line.product_type().unwrap_or("")) == lower(value),
            _ => continue,
        };
        let is_not = str_of(get(c, "op")) == Some("is_not");
        if if is_not { hit } else { !hit } {
            return false;
        }
    }
    true
}

fn cart_conditions_pass(cart: &Cart, conditions: &[JsonValue]) -> bool {
    for c in conditions {
        let op = str_of(get(c, "op"));
        match str_of(get(c, "field")) {
            Some("customer_tag") => {
                let want = lower(get(c, "value"));
                let hit = cart.customer_tags.iter().any(|t| *t == want);
                if if op == Some("not_contains") { hit } else { !hit } {
                    return false;
                }
            }
            Some("country") => {
                let hit = lower_str(cart.country.as_deref().unwrap_or("")) == lower(get(c, "value"));
                if if op == Some("is_not") { hit } else { !hit } {
                    return false;
                }
            }
            Some("cart_subtotal") => {
                let amount = js_number(get(c, "value"));
                if !amount.is_finite() {
                    continue;
                }
                if op == Some("gte") && !(cart.subtotal >= amount) {
                    return false;
                }
                if op == Some("lte") && !(cart.subtotal <= amount) {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

/// anyShared(customer.tags, wanted)
fn customer_has_any(cart: &Cart, wanted: Option<&JsonValue>) -> bool {
    if cart.customer_tags.is_empty() || !truthy(wanted) {
        return false;
    }
    match array(wanted) {
        Some(items) => items.iter().any(|w| {
            let w = lower(Some(w));
            cart.customer_tags.iter().any(|t| *t == w)
        }),
        None => false,
    }
}

fn cart_qualifies(rule: &JsonValue, cart: &Cart) -> bool {
    if let Some(exempt) = array(get(rule, "exempt")) {
        if !exempt.is_empty() && customer_has_any(cart, get(rule, "exempt")) {
            return false;
        }
    }
    let customer = get(rule, "customer").filter(|c| truthy(Some(*c)));
    match customer.and_then(|c| str_of(get(c, "type"))) {
        Some("logged_in") if !cart.logged_in => return false,
        Some("guest") if cart.logged_in => return false,
        Some("b2b") if !cart.b2b => return false,
        Some("tags") if !customer_has_any(cart, customer.and_then(|c| get(c, "tags"))) => return false,
        Some("exclude_tags") if customer_has_any(cart, customer.and_then(|c| get(c, "tags"))) => return false,
        _ => {}
    }
    if let Some(countries) = array(get(rule, "countries")) {
        if !countries.is_empty() {
            let Some(country) = cart.country.as_deref().filter(|c| !c.is_empty()) else {
                return false;
            };
            let want = lower_str(country);
            if !countries.iter().any(|c| lower(Some(c)) == want) {
                return false;
            }
        }
    }
    cart_conditions_pass(cart, conditions_of(rule))
}

fn conditions_of(rule: &JsonValue) -> &[JsonValue] {
    array(get(rule, "conditions")).map(|v| v.as_slice()).unwrap_or(&[])
}

/// Indexes of the lines this rule applies to, in cart order.
fn qualifying(rule: &JsonValue, cart: &Cart) -> Vec<usize> {
    let target = compile_target(get(rule, "target"));
    let conditions = conditions_of(rule);
    cart.lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line_matches(&target, line) && line_conditions_pass(line, conditions))
        .map(|(i, _)| i)
        .collect()
}

// ---------------------------------------------------------------------------
// Messages

const FALLBACK_MESSAGES: &[(&str, &str)] = &[
    ("max_quantity", "You can purchase a maximum of {{limit}} of {{product}}."),
    ("min_quantity", "{{product}} has a minimum order quantity of {{limit}}."),
    ("no_discount", "Discounts can't be applied to {{product}}. Remove the discount to continue."),
    ("cart_min_value", "Your cart must be at least {{limit}} to check out."),
    ("cart_max_value", "Your cart can't be more than {{limit}}."),
    ("quantity_multiple", "{{product}} is sold in multiples of {{limit}}."),
    ("group_limit", "You can buy at most {{limit}} items from {{collection}} per order."),
    ("max_cart_items", "Your cart can contain at most {{limit}} items."),
    ("product_combination", "{{product}} can't be purchased together with the other items in your cart."),
];

const KEYS: &[&str] = &["product", "limit", "quantity", "collection", "discount_code"];

fn default_var(key: &str) -> &'static str {
    match key {
        "product" => "this item",
        "collection" => "these products",
        "discount_code" => "your discount code",
        _ => "",
    }
}

#[derive(Clone)]
pub enum Var<'a> {
    Null,
    Str(String),
    Num(f64),
    Json(Option<&'a JsonValue>),
}

impl Var<'_> {
    fn render(&self, key: &str) -> String {
        match self {
            Var::Null => default_var(key).to_string(),
            Var::Str(s) if s.is_empty() => default_var(key).to_string(),
            Var::Str(s) => s.clone(),
            Var::Num(n) => js_num_to_string(*n),
            Var::Json(v) => match v {
                None | Some(JsonValue::Null) => default_var(key).to_string(),
                Some(JsonValue::String(s)) if s.is_empty() => default_var(key).to_string(),
                other => js_string(*other),
            },
        }
    }
}

pub struct Vars<'a> {
    pub product: Var<'a>,
    pub limit: Var<'a>,
    pub quantity: Var<'a>,
    pub collection: Var<'a>,
}

impl<'a> Vars<'a> {
    fn get(&self, key: &str) -> Var<'a> {
        match key {
            "product" => self.product.clone(),
            "limit" => self.limit.clone(),
            "quantity" => self.quantity.clone(),
            "collection" => self.collection.clone(),
            _ => Var::Null, // discount_code: the Function never knows it
        }
    }
}

fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

/// renderMessage(): /\{\{\s*(product|limit|quantity|collection|discount_code)\s*\}\}/g
pub fn render_message(template: Option<&JsonValue>, rule_type: &str, vars: &Vars) -> String {
    let text = if truthy(template) && !js_trim(&js_string(template)).is_empty() {
        js_string(template)
    } else {
        FALLBACK_MESSAGES
            .iter()
            .find(|(t, _)| *t == rule_type)
            .map(|(_, m)| m.to_string())
            .unwrap_or_default()
    };
    if !text.contains("{{") {
        return text;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some((key, consumed)) = placeholder(after) {
            out.push_str(&vars.get(key).render(key));
            rest = &after[consumed..];
        } else {
            // No match here: keep one "{" and try again from the next char,
            // as the regex scan would.
            out.push('{');
            rest = &rest[start + 1..];
        }
    }
    out.push_str(rest);
    out
}

/// After "{{": optional spaces, a key, optional spaces, "}}". Returns the key
/// and how many bytes were consumed.
fn placeholder(s: &str) -> Option<(&'static str, usize)> {
    let trimmed = s.trim_start_matches(is_js_space);
    let lead = s.len() - trimmed.len();
    // The regex alternation tries the keys in order; none is a prefix of
    // another, so the first that fits is the only one.
    let key: &'static str = KEYS.iter().copied().find(|k| trimmed.starts_with(*k))?;
    let after_key = &trimmed[key.len()..];
    let tail = after_key.trim_start_matches(is_js_space);
    if !tail.starts_with("}}") {
        return None;
    }
    let consumed = lead + key.len() + (after_key.len() - tail.len()) + 2;
    Some((key, consumed))
}

fn format_amount(value: f64, currency: Option<&str>) -> String {
    let text = if value.is_finite() { js_to_fixed2(value) } else { js_num_to_string(value) };
    match currency {
        Some(c) if !c.is_empty() => format!("{} {}", text, c),
        _ => text,
    }
}

// ---------------------------------------------------------------------------
// evaluateCart

pub struct Violation {
    pub rule_type: String,
    pub message: String,
}

const QUANTITY_TYPES: &[&str] = &["max_quantity", "min_quantity", "quantity_multiple"];

struct Claim<'a> {
    rule: &'a JsonValue,
    rule_type: &'a str,
    quantity: f64,
    line: usize,
}

fn priority_of(rule: &JsonValue) -> f64 {
    let p = js_number(get(rule, "priority"));
    if p.is_nan() {
        0.0
    } else {
        p
    }
}

/// better(): which of two claims on the same product wins.
fn better_is_b(rule_type: &str, a: &Claim, b: &Claim, priority_mode: bool) -> bool {
    if priority_mode {
        let (pa, pb) = (priority_of(a.rule), priority_of(b.rule));
        if pa != pb {
            return pb > pa;
        }
    }
    let va = js_number(get(a.rule, "value"));
    let vb = js_number(get(b.rule, "value"));
    if rule_type == "max_quantity" {
        vb < va
    } else {
        vb > va
    }
}

pub fn evaluate_cart(cart: &Cart, rules: &[JsonValue], conflict_mode: Option<&JsonValue>) -> Vec<Violation> {
    // (options && options.conflictMode) || "most_restrictive"
    let priority_mode = truthy(conflict_mode) && str_of(conflict_mode) == Some("priority");
    let currency = cart.currency.as_deref().filter(|c| !c.is_empty());
    let mut violations = Vec::new();
    let mut claims: Vec<Claim> = Vec::new();
    let mut claim_at: FxMap<(&str, bool, &str), usize> = FxMap::default();

    for rule in rules {
        // if (!rule || !rule.type) continue;
        if !truthy(Some(rule)) {
            continue;
        }
        let type_value = get(rule, "type");
        if !truthy(type_value) {
            continue;
        }
        let rule_type: &str = str_of(type_value).unwrap_or("");
        if !cart_qualifies(rule, cart) {
            continue;
        }
        let target_label = Var::Json(get(rule, "targetLabel"));
        let msg = get(rule, "msg");

        if QUANTITY_TYPES.contains(&rule_type) {
            let value = js_number(get(rule, "value"));
            if !(value >= 1.0) {
                continue;
            }
            let by_variant = truthy(get(rule, "target"))
                && str_of(get(rule, "target").and_then(|t| get(t, "type"))) == Some("variant");
            // Units per product (or variant), in cart order of first appearance.
            let mut groups: Vec<(&str, f64, usize)> = Vec::new();
            let mut group_at: FxMap<&str, usize> = FxMap::default();
            for i in qualifying(rule, cart) {
                let line = &cart.lines[i];
                let key = numeric_id_str(if by_variant { line.variant_id() } else { line.product_id() });
                match group_at.get(&key).copied() {
                    Some(g) => groups[g].1 += line.quantity,
                    None => {
                        group_at.insert(key, groups.len());
                        groups.push((key, line.quantity, i));
                    }
                }
            }
            for (key, quantity, line) in groups {
                let candidate = Claim { rule, rule_type, quantity, line };
                let slot = (rule_type, by_variant, key);
                match claim_at.get(&slot).copied() {
                    None => {
                        claim_at.insert(slot, claims.len());
                        claims.push(candidate);
                    }
                    Some(at) => {
                        if better_is_b(rule_type, &claims[at], &candidate, priority_mode) {
                            claims[at] = candidate;
                        }
                    }
                }
            }
            continue;
        }

        let matched = qualifying(rule, cart);

        match rule_type {
            "no_discount" => {
                for &i in &matched {
                    let line = &cart.lines[i];
                    if !line.has_discount() {
                        continue;
                    }
                    violations.push(Violation {
                        rule_type: rule_type.to_string(),
                        message: render_message(
                            msg,
                            rule_type,
                            &Vars {
                                product: Var::Str(line.title().to_string()),
                                limit: Var::Null,
                                quantity: Var::Num(line.quantity),
                                collection: target_label.clone(),
                            },
                        ),
                    });
                }
            }
            "cart_min_value" | "cart_max_value" | "max_cart_items" => {
                if matched.is_empty() {
                    continue;
                }
                let target = get(rule, "target");
                let is_all = !truthy(target) || str_of(target.and_then(|t| get(t, "type"))) == Some("all");
                let amount = if rule_type == "max_cart_items" {
                    matched.iter().map(|&i| cart.lines[i].quantity).sum::<f64>()
                } else if is_all && cart.subtotal.is_finite() {
                    cart.subtotal
                } else {
                    matched.iter().map(|&i| cart.lines[i].subtotal()).sum::<f64>()
                };
                let limit = js_number(get(rule, "value"));
                if !limit.is_finite() {
                    continue;
                }
                let broken = if rule_type == "cart_min_value" { amount < limit } else { amount > limit };
                if !broken {
                    continue;
                }
                let money = rule_type != "max_cart_items";
                violations.push(Violation {
                    rule_type: rule_type.to_string(),
                    message: render_message(
                        msg,
                        rule_type,
                        &Vars {
                            product: Var::Null,
                            limit: if money { Var::Str(format_amount(limit, currency)) } else { Var::Num(limit) },
                            quantity: if money { Var::Str(format_amount(amount, currency)) } else { Var::Num(amount) },
                            collection: target_label.clone(),
                        },
                    ),
                });
            }
            "group_limit" => {
                let limit = js_number(get(rule, "value"));
                if !(limit >= 1.0) || matched.is_empty() {
                    continue;
                }
                let total: f64 = matched.iter().map(|&i| cart.lines[i].quantity).sum();
                if total <= limit {
                    continue;
                }
                violations.push(Violation {
                    rule_type: rule_type.to_string(),
                    message: render_message(
                        msg,
                        rule_type,
                        &Vars {
                            product: target_label.clone(),
                            limit: Var::Num(limit),
                            quantity: Var::Num(total),
                            collection: target_label.clone(),
                        },
                    ),
                });
            }
            "product_combination" => {
                let combo = compile_target(get(rule, "comboTarget"));
                let group_b: Vec<usize> =
                    (0..cart.lines.len()).filter(|&i| line_matches(&combo, &cart.lines[i])).collect();
                if matched.is_empty() || group_b.is_empty() {
                    continue;
                }
                // The same line on both sides isn't a combination.
                let pair = matched.iter().find(|&&a| group_b.iter().any(|&b| b != a));
                let Some(&pair) = pair else { continue };
                violations.push(Violation {
                    rule_type: rule_type.to_string(),
                    message: render_message(
                        msg,
                        rule_type,
                        &Vars {
                            product: Var::Str(cart.lines[pair].title().to_string()),
                            limit: Var::Null,
                            quantity: Var::Null,
                            collection: target_label.clone(),
                        },
                    ),
                });
            }
            _ => {}
        }
    }

    for claim in &claims {
        let limit = js_number(get(claim.rule, "value"));
        let q = claim.quantity;
        let broken = match claim.rule_type {
            "max_quantity" => q > limit,
            "min_quantity" => q > 0.0 && q < limit,
            "quantity_multiple" => q % limit != 0.0,
            _ => false,
        };
        if !broken {
            continue;
        }
        let line = &cart.lines[claim.line];
        violations.push(Violation {
            rule_type: claim.rule_type.to_string(),
            message: render_message(
                get(claim.rule, "msg"),
                claim.rule_type,
                &Vars {
                    product: Var::Str(line.title().to_string()),
                    limit: Var::Num(limit),
                    quantity: Var::Num(q),
                    collection: Var::Json(get(claim.rule, "targetLabel")),
                },
            ),
        });
    }

    violations
}
