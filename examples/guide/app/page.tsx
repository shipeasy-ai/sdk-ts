import { entities, SDK_NOT_WIRED, type Entity } from "./entities";

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠ SDK NOT WIRED YET — every value rendered below is a placeholder constant
 *  from ./entities.ts. There are NO network calls. Each card shows the REAL
 *  SDK call it maps to. To make a card live, install the SDK and replace the
 *  matching TODO with a real client call:
 *
 *   // TODO: once @shipeasy/sdk is installed
 *   import { shipeasy } from "@shipeasy/sdk/server";
 *   import { see } from "@shipeasy/sdk/server";
 *   const client = await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY ?? "" });
 *
 *   // 1. FEATURE FLAG
 *   const on = client.getFlag("new_checkout", { user_id: "u_123" });
 *   const flagDetail = client.getFlagDetail("new_checkout", { user_id: "u_123" });
 *
 *   // 2. DYNAMIC CONFIG
 *   const cfg = client.getConfig("billing_copy");
 *
 *   // 3. A/B EXPERIMENT
 *   const { group, params } = client.getExperiment(
 *     "checkout_button", { user_id: "u_123" }, { color: "#888", label: "Buy" });
 *
 *   // 4. KILL SWITCH
 *   const boot = client.evaluate({ user_id: "u_123" });
 *   const paused = boot.killswitches["payments_paused"];
 *
 *   // 5. EVENT / METRIC
 *   client.track("u_123", "checkout_completed", { revenue: 49.99, plan: "pro" });
 *
 *   // 6. I18N LABEL  (configured in the root layout — see app/layout.tsx)
 *   const title = client.t("hero.title", { name: "Sam" });
 *
 *   // 7. ERROR REPORTING
 *   try { await submitOrder(o); }
 *   catch (e) { see(e).causes_the("checkout").to("use cached prices").extras({ order_id: o.id }); }
 *
 *  ...then feed the results into the cards instead of the placeholder consts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function EntityCard({ entity }: { entity: Entity }) {
  // `--accent` drives the pill + key colours for this card (set per card).
  const accentStyle = { ["--accent" as string]: entity.accent } as React.CSSProperties;

  return (
    <article className="card" style={accentStyle}>
      <div className="card__top">
        <span className="pill pill--label">{entity.label}</span>
        <span className="pill pill--value" title={entity.valuePill}>
          {entity.valuePill}
        </span>
      </div>

      <h2 className="card__key">{entity.entityKey}</h2>
      <p className="card__desc">{entity.description}</p>

      <div className="code">
        <span className="code__caption">
          {/* The same call appears as a // TODO block in the source above. */}
          SDK call · TODO once @shipeasy/sdk is installed
        </span>
        <pre>
          <code>{entity.call}</code>
        </pre>
      </div>

      <p className="card__meta">{entity.meta}</p>
    </article>
  );
}

export default function Page() {
  return (
    <main className="page">
      <header className="hero">
        <h1 className="hero__title">
          Shipeasy <span className="dot">·</span> TypeScript Entity Guide
        </h1>
        <p className="hero__subtitle">
          One card per Shipeasy entity — what it is, the SDK call that produces
          it, and its current value. Read it top to bottom like a guide.
        </p>
        <div className="banner" role="status">
          <span aria-hidden="true">⚠</span>
          <span>{SDK_NOT_WIRED}</span>
        </div>
      </header>

      <section className="cards">
        {entities.map((entity) => (
          <EntityCard key={entity.id} entity={entity} />
        ))}
      </section>

      <footer className="footer">
        <p>
          Run it: <code>npm install</code> then <code>npm run dev</code> →{" "}
          <code>http://localhost:3000</code>.
        </p>
        <p>
          Next step: install <code>@shipeasy/sdk</code>, configure the server
          key in <code>app/layout.tsx</code>, and replace each{" "}
          <code>// TODO</code> with a real client call.
        </p>
        <p>
          Docs:{" "}
          <a href="https://docs.shipeasy.ai" target="_blank" rel="noreferrer">
            https://docs.shipeasy.ai
          </a>
        </p>
      </footer>
    </main>
  );
}
