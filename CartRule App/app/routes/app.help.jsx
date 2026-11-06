import { useMemo, useState } from "react";
import { json } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  BlockStack,
  InlineStack,
  Text,
  Button,
  TextField,
  Select,
  Icon,
} from "@shopify/polaris";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  InfoIcon,
  SearchIcon,
  StarIcon,
} from "@shopify/polaris-icons";
import pkg from "../../package.json";
import { authenticate } from "../shopify.server";
import { loadAppContext } from "../models/context.server";
import { diagnoseRule } from "../models/diagnose.server";
import { ensureValidationActive } from "../models/rules.server";
import { useActionToast } from "../utils/useActionToast";
import {
  getCartThemeEditorDeepLink,
  getThemeEditorDeepLink,
} from "../utils/themeEditor";
import { AppPage, Box, Segmented } from "../components/ui";

const SUPPORT_EMAIL = "team@mpctrades.com";
const APP_STORE_REVIEWS_URL = "https://apps.shopify.com/cartrules/reviews";

function appVersion() {
  const commit = (
    process.env.GIT_COMMIT ||
    process.env.SOURCE_VERSION ||
    ""
  ).slice(0, 7);
  const base = pkg.version ? `v${pkg.version}` : "";
  return [base, commit].filter(Boolean).join(" · ") || "development build";
}

// No email-sending backend for support — submissions open a prefilled
// mailto: draft instead of a fake "ticket submitted" confirmation.
export const loader = async ({ request }) => {
  const ctx = await loadAppContext(request);
  const { admin, shop, plan, rules } = ctx;
  const checkId = new URL(request.url).searchParams.get("check");
  let diagnosis = null;
  if (checkId) {
    try {
      diagnosis = await diagnoseRule(ctx, checkId);
    } catch (error) {
      console.error("Rule check failed", { shop, error });
      diagnosis = { error: true };
    }
  }
  let shopifyPlan = null;
  try {
    const response = await admin.graphql(`#graphql
      query CartRulesHelpShopPlan { shop { plan { publicDisplayName } } }`);
    const data = await response.json();
    shopifyPlan = data.data?.shop?.plan?.publicDisplayName ?? null;
  } catch (error) {
    console.error("Could not read Shopify plan", error);
  }
  return json({
    shop,
    currentPlan: plan.name,
    shopifyPlan,
    version: appVersion(),
    rules: rules.map((r) => ({ id: r.id, title: r.title || "Untitled rule" })),
    diagnosis,
  });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const intent = (await request.formData()).get("intent");
  if (intent === "enableValidation") {
    try {
      await ensureValidationActive(admin);
      return json({ ok: true, toast: "CartRules is now enforced at checkout" });
    } catch (error) {
      if (error instanceof Response) throw error;
      console.error("Could not enable validation from Help", error);
      return json({
        ok: false,
        toast: "Something went wrong. Please try again.",
        toastError: true,
      });
    }
  }
  return json({ ok: false }, { status: 400 });
};

const SECTIONS = [
  { id: "all", label: "All" },
  { id: "getting-started", label: "Getting started" },
  { id: "creating-rules", label: "Creating rules" },
  { id: "storefront", label: "Storefront setup" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "billing", label: "Billing" },
];

const ARTICLES = [
  {
    section: "getting-started",
    title: "How CartRules protects your store",
    body: "Your rules are checked by a Shopify checkout rule (Settings → Checkout → Checkout rules → CartRules). When a cart breaks a rule, checkout is blocked and the shopper sees your message. Optional theme blocks warn shoppers earlier, on the product and cart pages.",
  },
  {
    section: "getting-started",
    title: "Your first rule in two minutes",
    body: "Go to Rules → Create rule, pick a rule type, choose which products it applies to, set the limit and save. Then use Test a rule to try a real product and quantity against it before a shopper does.",
  },
  {
    section: "creating-rules",
    title: "Rule types",
    body: "Maximum and minimum quantity, block discounts, minimum and maximum cart value, quantity multiples (e.g. 6, 12, 18), maximum cart items, and product combinations that can't be bought together.",
  },
  {
    section: "creating-rules",
    title: "Targeting and conditions",
    body: "A rule can apply to all products, specific products or variants, collections, product tags, vendors or product types. You can also limit it to some customers (logged in, guests, tags, B2B), to countries or Shopify Markets, and add extra conditions such as a product tag or cart subtotal.",
  },
  {
    section: "creating-rules",
    title: "Scheduling a rule",
    body: "Give a rule a start and end date and time (in your store's timezone). It turns on and off by itself — handy for flash sales and drops.",
  },
  {
    section: "storefront",
    title: "Add the product page notice",
    body: "Theme editor → Product template → Add block → Apps → Product rule notice. It shows the rules that apply to the product and lowers a quantity above the maximum before it's added to the cart. No code changes.",
    action: "product",
  },
  {
    section: "storefront",
    title: "Add the cart quantity guard",
    body: "Theme editor → Cart template → Add block → Apps → Cart quantity guard. It explains every rule the cart breaks and lowers quantities above a maximum, before checkout.",
    action: "cart",
  },
  {
    section: "troubleshooting",
    title: "Check Store health first",
    body: "The Overview's Store health card shows whether the checkout rule is active, which theme blocks are installed, and any rule conflicts — most problems show up there with a Fix button.",
  },
  {
    section: "billing",
    title: "Plans and limits",
    body: "Free includes 3 active rules with quantity and discount rules. Growth adds unlimited rules, all rule types, collection/tag targeting, custom messages and scheduling. Pro adds customer and market conditions, rule priority and 365 days of analytics. Billing goes through your Shopify invoice.",
  },
  {
    section: "billing",
    title: "What happens when I downgrade?",
    body: "Rules that use features your new plan doesn't include — or active rules beyond Free's 3 — are paused, not deleted. Upgrade again to turn them back on.",
  },
];

const FAQ = [
  {
    q: "How does CartRules work?",
    a: "CartRules adds a checkout rule to your store. At checkout it checks the cart against your active rules and blocks checkout with your message when one is broken. Optional theme blocks show the same rules on product and cart pages.",
  },
  {
    q: "Can I limit only specific products?",
    a: "Yes. Target specific products or variants, collections, product tags, vendors or product types — or all products.",
  },
  {
    q: "Can I block discounts for selected products?",
    a: "Yes. Create a Block discounts rule for those products. If a discount is on one of them, checkout is blocked with your message until the code is removed. It counts every discount on those products, including automatic discounts, so exclude them from automatic discounts you run.",
  },
  {
    q: "Can I pause a rule?",
    a: "Yes. Use the ••• menu on the Rules page. A paused rule keeps its settings and stops being enforced until you activate it again.",
  },
  {
    q: "Can customers see why an item is blocked?",
    a: "Yes. Each rule shows a message at checkout (yours, or the default from Settings), and the theme blocks show it on the product and cart pages.",
  },
  {
    q: "Do I need to edit my Shopify theme?",
    a: "No code. Checkout enforcement works without any theme change. The optional product notice and cart guard are app blocks you add in the theme editor with a few clicks.",
  },
  {
    q: "Can I use CartRules in another language?",
    a: "Yes. Messages you write are shown exactly as written, in any language. Default messages follow your store's primary language when it's one of the built-in languages (Settings → Language).",
  },
  {
    q: "What happens if two rules apply?",
    a: "For quantity rules of the same type, only one applies — the most restrictive by default, or the highest priority if you choose that in Settings → Rule behavior. Other rule types all apply. The Overview and Rules pages list any conflicts.",
  },
];

const TROUBLESHOOTING = [
  {
    q: "Rule isn't triggering",
    a: "Check that the rule is Active (not paused, draft, or outside its scheduled dates); that CartRules protection is on in Settings; that the CartRules checkout rule is enabled in Shopify (Settings → Checkout → Checkout rules); and that the product really matches the rule's target and conditions. Test a rule shows exactly what checkout will do for a product and quantity.",
  },
  {
    q: "Storefront message isn't showing",
    a: "Check that the Product rule notice or Cart quantity guard block is added in your live theme (Settings shows whether it's installed), that product notices or cart warnings are on in Settings, and that a rule actually applies to the product you're viewing.",
  },
  {
    q: "Discount is still applying",
    a: "A Block discounts rule doesn't remove a discount — it stops checkout until the shopper removes it, and shows your message. If checkout still goes through, check that the rule is Active, the product matches its target, protection is on, and the CartRules checkout rule is enabled in Shopify.",
  },
];

const TOPICS = [
  "Setup help",
  "Rule not working",
  "Billing",
  "Feature request",
  "Bug report",
  "Other",
].map((t) => ({
  label: t,
  value: t,
}));

function buildMailto({ subject, body }) {
  const params = new URLSearchParams({ subject, body });
  return `mailto:${SUPPORT_EMAIL}?${params.toString().replace(/\+/g, "%20")}`;
}

function gmailComposeUrl({ subject, body }) {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: SUPPORT_EMAIL,
    su: subject,
    body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

// Clipboard inside the admin iframe can be blocked; fall back to a hidden
// textarea + execCommand, which works in embedded apps.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_e) {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch (_e2) {
      return false;
    }
  }
}

const FINDING_STYLE = {
  bad: { icon: AlertCircleIcon, tone: "critical" },
  warn: { icon: AlertTriangleIcon, tone: "caution" },
  ok: { icon: CheckCircleIcon, tone: "success" },
  info: { icon: InfoIcon, tone: "subdued" },
};

function RuleChecker({ rules, diagnosis }) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  useActionToast(fetcher);
  const [searchParams, setSearchParams] = useSearchParams();
  const [ruleId, setRuleId] = useState(
    searchParams.get("check") ?? rules[0]?.id ?? "",
  );
  const checking =
    navigation.state === "loading" &&
    navigation.location?.search?.includes("check=");

  const run = () => {
    const next = new URLSearchParams(searchParams);
    next.set("check", ruleId);
    setSearchParams(next, { preventScrollReset: true });
  };

  return (
    <Box
      title="Why isn't my rule working?"
      subtitle="Pick a rule and we'll check everything that can stop it — and tell you how to fix it."
    >
      {rules.length === 0 ? (
        <Text as="p" tone="subdued">
          You don&apos;t have any rules yet.{" "}
          <Button variant="plain" onClick={() => navigate("/app/rules/new")}>
            Create your first rule
          </Button>
        </Text>
      ) : (
        <BlockStack gap="400">
          <div className="cr-check-bar">
            <div style={{ flex: 1, minWidth: 200 }}>
              <Select
                label="Rule"
                labelHidden
                options={rules.map((r) => ({ label: r.title, value: r.id }))}
                value={ruleId}
                onChange={setRuleId}
              />
            </div>
            <Button variant="primary" onClick={run} loading={checking}>
              Check rule
            </Button>
          </div>
          {diagnosis?.error ? (
            <Text as="p" tone="critical">
              We couldn&apos;t check this rule right now. Please try again in a
              moment.
            </Text>
          ) : diagnosis?.rule ? (
            <div className="cr-list" style={{ opacity: checking ? 0.5 : 1 }}>
              <div className="cr-list-row">
                <Text as="p" tone="subdued" variant="bodySm">
                  Results for <strong>{diagnosis.rule.title}</strong> ·{" "}
                  {diagnosis.rule.summary}
                </Text>
              </div>
              {diagnosis.findings.map((f) => {
                const style = FINDING_STYLE[f.severity];
                return (
                  <div
                    key={f.title}
                    className="cr-list-row cr-finding"
                    style={{ alignItems: "flex-start" }}
                  >
                    <InlineStack gap="300" blockAlign="start" wrap={false}>
                      <span
                        className={`cr-finding__icon cr-finding__icon--${f.severity}`}
                      >
                        <Icon source={style.icon} tone={style.tone} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <Text as="p" fontWeight="semibold">
                          {f.title}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          {f.detail}
                        </Text>
                      </div>
                    </InlineStack>
                    {f.fix ? (
                      <Button
                        size="slim"
                        variant={f.severity === "bad" ? "primary" : "secondary"}
                        loading={
                          f.fix.intent ? fetcher.state !== "idle" : false
                        }
                        onClick={() => {
                          if (f.fix.intent)
                            fetcher.submit(
                              { intent: f.fix.intent },
                              { method: "post" },
                            );
                          else if (f.fix.href)
                            window.open(f.fix.href, "_blank");
                          else navigate(f.fix.to);
                        }}
                      >
                        {f.fix.label}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </BlockStack>
      )}
    </Box>
  );
}

// Asking for a review is a plain link — never tied to features or rewards
// (App Store requirement 1.3). The in-app review prompt is requested
// separately, after a rule has been saved and has stopped real shoppers.
function ReviewCard() {
  return (
    <section className="cr-card cr-review-card">
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        <span className="cr-rule-icon">
          <Icon source={StarIcon} />
        </span>
        <div style={{ minWidth: 0 }}>
          <Text as="p" fontWeight="semibold">
            Is CartRules helping your store?
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            A short review on the Shopify App Store helps other merchants decide
            — and tells us what to improve.
          </Text>
        </div>
      </InlineStack>
      <Button onClick={() => window.open(APP_STORE_REVIEWS_URL, "_blank")}>
        Leave a review
      </Button>
    </section>
  );
}

function AccordionItem({ question, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="cr-list-row" style={{ display: "block" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          width: "100%",
          padding: 0,
          border: "none",
          background: "none",
          font: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <Text as="span" fontWeight="medium">
          {question}
        </Text>
        <span style={{ flexShrink: 0 }}>
          <Icon
            source={open ? ChevronUpIcon : ChevronDownIcon}
            tone="subdued"
          />
        </span>
      </button>
      {open ? (
        <div style={{ paddingTop: 8 }}>
          <Text as="p" tone="subdued">
            {children}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

const matches = (query, ...texts) =>
  !query || texts.join(" ").toLowerCase().includes(query.toLowerCase());

export default function Help() {
  const { shop, currentPlan, shopifyPlan, version, rules, diagnosis } =
    useLoaderData();
  const [copied, setCopied] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [section, setSection] = useState("all");

  const initialTopic = TOPICS.some((t) => t.value === searchParams.get("topic"))
    ? searchParams.get("topic")
    : "Setup help";
  const initialRule = rules.some((r) => r.id === searchParams.get("ruleId"))
    ? searchParams.get("ruleId")
    : "";
  const [topic, setTopic] = useState(initialTopic);
  const [ruleId, setRuleId] = useState(initialRule);
  const [message, setMessage] = useState("");

  const articles = ARTICLES.filter(
    (a) =>
      (section === "all" || a.section === section) &&
      matches(query, a.title, a.body),
  );
  const faq = FAQ.filter((f) => matches(query, f.q, f.a));
  const trouble = TROUBLESHOOTING.filter((t) => matches(query, t.q, t.a));
  const showFaq =
    section === "all" ||
    section === "getting-started" ||
    section === "creating-rules";
  const showTrouble = section === "all" || section === "troubleshooting";
  const nothing =
    articles.length === 0 &&
    (!showFaq || faq.length === 0) &&
    (!showTrouble || trouble.length === 0);

  const rule = rules.find((r) => r.id === ruleId);
  const supportInfo = useMemo(
    () =>
      [
        `Store domain: ${shop}`,
        `CartRules version: ${version}`,
        `Current plan: ${currentPlan}`,
        `Shopify plan: ${shopifyPlan ?? "unknown"}`,
        rule ? `Rule: ${rule.title} (${rule.id})` : null,
      ].filter(Boolean),
    [shop, version, currentPlan, shopifyPlan, rule],
  );

  const subject = `CartRules — ${topic}`;
  const body = `${message}\n\n---\nTopic: ${topic}\n${supportInfo.join("\n")}`;
  const send = () => window.open(buildMailto({ subject, body }), "_blank");
  const copy = async (what, text) => {
    const ok = await copyText(text);
    setCopied(ok ? what : "failed");
    setTimeout(() => setCopied(""), 2500);
  };

  const contactRef = (el) => {
    if (el && searchParams.get("topic")) el.scrollIntoView({ block: "start" });
  };

  return (
    <AppPage
      title="Help & support"
      subtitle="Everything you need to get CartRules working properly."
      actions={
        <Button
          onClick={() => {
            setTopic("Feature request");
            document
              .getElementById("cr-contact")
              ?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          Request a feature
        </Button>
      }
    >
      <RuleChecker rules={rules} diagnosis={diagnosis} />

      <Box>
        <BlockStack gap="300">
          <TextField
            label="Search help"
            labelHidden
            placeholder="Search help..."
            prefix={<Icon source={SearchIcon} />}
            value={query}
            onChange={setQuery}
            clearButton
            onClearButtonClick={() => setQuery("")}
            autoComplete="off"
          />
          <div style={{ overflowX: "auto" }}>
            <Segmented
              label="Help sections"
              options={SECTIONS.map((s) => ({ label: s.label, value: s.id }))}
              value={section}
              onChange={setSection}
            />
          </div>
        </BlockStack>
      </Box>

      {nothing ? (
        <Box>
          <Text as="p" tone="subdued">
            Nothing matches “{query}”. Try another word, or contact support
            below.
          </Text>
        </Box>
      ) : null}

      {articles.length ? (
        <div className="cr-grid cr-grid--2">
          {articles.map((a) => (
            <Box
              key={a.title}
              title={a.title}
              subtitle={SECTIONS.find((s) => s.id === a.section)?.label}
            >
              <BlockStack gap="300">
                <Text as="p">{a.body}</Text>
                {a.action === "product" ? (
                  <InlineStack>
                    <Button
                      onClick={() =>
                        window.open(getThemeEditorDeepLink(shop), "_blank")
                      }
                    >
                      Add to product page
                    </Button>
                  </InlineStack>
                ) : null}
                {a.action === "cart" ? (
                  <InlineStack>
                    <Button
                      onClick={() =>
                        window.open(getCartThemeEditorDeepLink(shop), "_blank")
                      }
                    >
                      Add to cart
                    </Button>
                  </InlineStack>
                ) : null}
              </BlockStack>
            </Box>
          ))}
        </div>
      ) : null}

      {showFaq && faq.length ? (
        <Box title="Frequently asked questions">
          <div className="cr-list">
            {faq.map((f) => (
              <AccordionItem
                key={f.q}
                question={f.q}
                defaultOpen={Boolean(query)}
              >
                {f.a}
              </AccordionItem>
            ))}
          </div>
        </Box>
      ) : null}

      {showTrouble && trouble.length ? (
        <Box
          title="Troubleshooting"
          actions={
            <Button variant="plain" onClick={() => navigate("/app/test")}>
              Test a rule
            </Button>
          }
        >
          <div className="cr-list">
            {trouble.map((t) => (
              <AccordionItem
                key={t.q}
                question={t.q}
                defaultOpen={Boolean(query)}
              >
                {t.a}
              </AccordionItem>
            ))}
          </div>
        </Box>
      ) : null}

      <ReviewCard />

      <div id="cr-contact" ref={contactRef}>
        <Box
          title="Still need help?"
          subtitle={`Write to us and we'll reply by email from ${SUPPORT_EMAIL}. Nothing is sent until you send it from your mail.`}
        >
          <BlockStack gap="300">
            <div className="cr-grid cr-grid--2">
              <Select
                label="Topic"
                options={TOPICS}
                value={topic}
                onChange={setTopic}
              />
              <Select
                label="Related rule (optional)"
                options={[
                  { label: "None", value: "" },
                  ...rules.map((r) => ({ label: r.title, value: r.id })),
                ]}
                value={ruleId}
                onChange={setRuleId}
              />
            </div>
            <TextField
              label={
                topic === "Feature request"
                  ? "What would you like CartRules to do?"
                  : "How can we help?"
              }
              value={message}
              onChange={setMessage}
              multiline={5}
              autoComplete="off"
            />
            <div
              style={{
                background: "var(--p-color-bg-surface-secondary)",
                borderRadius: 10,
                padding: "12px 14px",
              }}
            >
              <Text as="p" variant="bodySm" tone="subdued">
                Attached automatically to help us help you faster:
              </Text>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
                {supportInfo.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <InlineStack align="end" gap="200">
              <Button
                disabled={!message.trim()}
                onClick={() =>
                  window.open(gmailComposeUrl({ subject, body }), "_blank")
                }
              >
                Open in Gmail
              </Button>
              <Button
                variant="primary"
                disabled={!message.trim()}
                onClick={send}
              >
                Open email app
              </Button>
            </InlineStack>
            <div className="cr-contact-fallback">
              <Text as="p" variant="bodySm" tone="subdued">
                Neither works? Copy your message and email it to{" "}
                <strong>{SUPPORT_EMAIL}</strong> from any mail service.
              </Text>
              <InlineStack gap="200">
                <Button
                  size="slim"
                  disabled={!message.trim()}
                  onClick={() =>
                    copy(
                      "message",
                      `To: ${SUPPORT_EMAIL}\nSubject: ${subject}\n\n${body}`,
                    )
                  }
                >
                  {copied === "message" ? "Message copied ✓" : "Copy message"}
                </Button>
                <Button
                  size="slim"
                  onClick={() => copy("email", SUPPORT_EMAIL)}
                >
                  {copied === "email"
                    ? "Address copied ✓"
                    : "Copy email address"}
                </Button>
              </InlineStack>
              {copied === "failed" ? (
                <Text as="p" variant="bodySm" tone="critical">
                  Your browser blocked copying — please select the text and copy
                  it yourself.
                </Text>
              ) : null}
            </div>
          </BlockStack>
        </Box>
      </div>
    </AppPage>
  );
}
