/**
 * Placeholder entity data for the Shipeasy TypeScript Entity Guide.
 *
 * ⚠ THE SDK IS NOT WIRED IN YET.
 * Every `value` below is a hardcoded placeholder so the app builds and runs
 * with zero network calls. Each entity carries the REAL SDK call it maps to in
 * `call` — that's what you'd uncomment (see the `// TODO` blocks in page.tsx)
 * once you `npm install @shipeasy/sdk` and configure a key.
 */

export interface Entity {
  /** Stable id used as a React key. */
  id: string;
  /** UPPERCASE pill label, e.g. "FEATURE FLAG". */
  label: string;
  /** Accent colour (hex) for the pills + key. */
  accent: string;
  /** The sample entity key (mono title), e.g. "new_checkout". */
  entityKey: string;
  /** Short pill rendering of the current value. */
  valuePill: string;
  /** One-paragraph description of what the entity is. */
  description: string;
  /** The real SDK call, shown as a code block (and as a TODO in page.tsx). */
  call: string;
  /** Faint meta line under the code block. */
  meta: string;
}

export const SDK_NOT_WIRED =
  "⚠ SDK not wired yet — every value below is a placeholder. Install @shipeasy/sdk and replace the TODOs to make them live.";

export const entities: Entity[] = [
  {
    id: "flag",
    label: "Feature flag",
    accent: "#34d399",
    entityKey: "new_checkout",
    valuePill: "true",
    description:
      "A boolean on/off switch with targeting rules + percentage rollout. Returns true/false per user.",
    call: [
      'const on = client.getFlag("new_checkout", { user_id: "u_123" });',
      "",
      "// Need the why? getFlagDetail returns { value, reason }:",
      'const detail = client.getFlagDetail("new_checkout", { user_id: "u_123" });',
      "// detail.value === true, detail.reason === \"RULE_MATCH\"",
    ].join("\n"),
    meta: "reason: RULE_MATCH · evaluated for user u_123",
  },
  {
    id: "config",
    label: "Dynamic config",
    accent: "#60a5fa",
    entityKey: "billing_copy",
    valuePill: '{ "headline": "Welcome back 👋", "cta": "Upgrade to Pro" }',
    description:
      "A typed JSON blob you change without deploying — copy, limits, thresholds.",
    call: 'const cfg = client.getConfig("billing_copy");',
    meta: "served from the flags blob · no redeploy to change",
  },
  {
    id: "experiment",
    label: "A/B experiment",
    accent: "#c084fc",
    entityKey: "checkout_button",
    valuePill:
      'group: "treatment" · params: { color: "#34d399", label: "Buy now" }',
    description:
      "Splits users into variants and measures a metric. Returns the assigned group + its params.",
    call: [
      "const { inExperiment, group, params } = client.getExperiment(",
      '  "checkout_button",',
      '  { user_id: "u_123" },',
      '  { color: "#888", label: "Buy" }, // fallback params if not enrolled',
      ");",
    ].join("\n"),
    meta: "inExperiment: true · group: treatment · evaluated for user u_123",
  },
  {
    id: "killswitch",
    label: "Kill switch",
    accent: "#f87171",
    entityKey: "payments_paused",
    valuePill: "false  (payments live)",
    description:
      "An operational off-switch shipped in the same blob as flags — flip it to instantly disable a subsystem during an incident.",
    call: [
      "const boot = client.evaluate({ user_id: \"u_123\" });",
      'const paused = boot.killswitches["payments_paused"];',
      "// ships alongside flags / configs / experiments in the bootstrap payload",
    ].join("\n"),
    meta: "payments_paused: false · subsystem live",
  },
  {
    id: "event",
    label: "Event / metric",
    accent: "#22d3ee",
    entityKey: "checkout_completed",
    valuePill: 'last event queued: { revenue: 49.99, plan: "pro" }',
    description:
      "Fire-and-forget events that power experiment metrics and dashboards.",
    call:
      'client.track("u_123", "checkout_completed", { revenue: 49.99, plan: "pro" });',
    meta: "write-only · no return value · powers experiment metrics",
  },
  {
    id: "i18n",
    label: "i18n label",
    accent: "#fbbf24",
    entityKey: "hero.title",
    valuePill: '"Ship features, not stress"',
    description:
      "Server-managed copy you translate + publish from the dashboard — no redeploy.",
    call: [
      "// Next.js root layout — one server-side configure call:",
      "const se = await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY ?? \"\" });",
      "const { t } = se;",
      "",
      "// then anywhere on the server:",
      't("hero.title", { name: "Sam" }); // → "Ship features, not stress"',
    ].join("\n"),
    meta: "hero.title · resolved server-side via the server key",
  },
  {
    id: "see",
    label: "Error reporting",
    accent: "#f87171",
    entityKey: "see()",
    valuePill: "0 issues reported this session",
    description:
      "Structured error reports that document the product consequence, not just a stack trace.",
    call: [
      "try {",
      "  await submitOrder(o);",
      "} catch (e) {",
      '  see(e)',
      '    .causes_the("checkout")',
      '    .to("use cached prices")',
      "    .extras({ order_id: o.id });",
      "}",
    ].join("\n"),
    meta: "0 issues reported this session",
  },
];
