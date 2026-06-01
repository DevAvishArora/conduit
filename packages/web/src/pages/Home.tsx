import { Link } from "react-router-dom";

/**
 * Public landing page (route `/`). Marketing surface + entry into the app.
 * Aurora gradient backdrop + frosted glass cards + animated CTA.
 */
export function Home(): JSX.Element {
  return (
    <>
      <div className="aurora" />
      <nav className="gnav">
        <div className="brand">
          <span className="mark">◆</span>
          Conduit
        </div>
        <div className="spacer" />
        <Link to="/sign-in">Sign in</Link>
        <Link to="/sign-up" className="cta-primary" style={{ padding: "8px 16px", fontSize: 14 }}>
          Get started — it&apos;s free
        </Link>
      </nav>

      <section className="hero">
        <div className="pill">
          <span>✦</span> Self-hostable workflow automation
        </div>
        <h1>
          Wire any service to any other.{" "}
          <span className="gradient-text">In minutes, not weeks.</span>
        </h1>
        <p className="lede">
          Conduit is an open-source workflow engine for engineers who want Zapier-grade ergonomics
          without the per-task pricing or vendor lock-in. Drag nodes, drop triggers, ship reliable
          automations with retries, branching, loops, and full observability built in.
        </p>
        <div className="ctas">
          <Link to="/sign-up" className="cta-primary">
            Start building →
          </Link>
          <a href="https://github.com/" className="cta-secondary" target="_blank" rel="noreferrer">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            View on GitHub
          </a>
        </div>
      </section>

      <section className="features">
        <div className="feature-card">
          <div className="ic" aria-hidden>
            🎨
          </div>
          <h3>Visual builder</h3>
          <p>
            Drag-and-drop DAG editor. Connect triggers to actions, branch on conditions, loop until
            done. Zero JSON unless you want it.
          </p>
        </div>
        <div className="feature-card">
          <div className="ic" aria-hidden>
            ⚡
          </div>
          <h3>Webhook &amp; cron triggers</h3>
          <p>
            HMAC-signed webhooks with replay protection. Cron schedules down to the minute.
            Reschedule, pause, resume — all from the API.
          </p>
        </div>
        <div className="feature-card">
          <div className="ic" aria-hidden>
            🔁
          </div>
          <h3>Conditions, loops, branches</h3>
          <p>
            Logic primitives that aren&apos;t just toggles: structured operators, typed templating,
            bounded iteration. Workflows you can actually reason about.
          </p>
        </div>
        <div className="feature-card">
          <div className="ic" aria-hidden>
            🔭
          </div>
          <h3>Real-time observability</h3>
          <p>
            Live SSE timeline per run. Per-attempt inspector with input/output snapshots. Prometheus
            metrics on every service. No black box.
          </p>
        </div>
        <div className="feature-card">
          <div className="ic" aria-hidden>
            🔐
          </div>
          <h3>Tenant-isolated by default</h3>
          <p>
            Postgres row-level security keeps tenants separate at the database level — not just in
            app code. Secrets are envelope-encrypted with per-tenant DEKs.
          </p>
        </div>
        <div className="feature-card">
          <div className="ic" aria-hidden>
            🧱
          </div>
          <h3>Pluggable connectors</h3>
          <p>
            Ship a Slack, Notion, or Stripe connector as its own package. Conduit picks it up via
            the same handler registry every built-in uses.
          </p>
        </div>
      </section>

      <footer className="public-footer">
        © {new Date().getFullYear()} Conduit · Open source · Self-host or run it for us
      </footer>
    </>
  );
}
