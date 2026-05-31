/**
 * Active failure notification (closes the brief's "Error notifications to the
 * user" item). When the dispatcher finalises a run as FAILED, it looks up the
 * tenant's `connector_configs` row for connector_type='failure_notify' and, if
 * present, fires the Notify handler inline.
 *
 * The config matches the NOTIFY node's shape so the same handler can execute:
 *   { channel: "slack" | "email", config: { webhook_url_secret?, to?, ... } }
 *
 * This is best-effort and fire-and-forget: a notification failure never makes
 * the run "more failed". Errors are logged.
 */
import "@conduit/shared/handlers"; // side-effect: ensure NotifyHandler is registered
import {
  getHandler,
  loadConfig,
  logger,
  renderDeep,
  secretResolver,
  withTenant,
} from "@conduit/shared";

interface FailureNotifyConfig {
  channel: "slack" | "email";
  config: {
    webhook_url_secret?: string;
    to?: string;
    subject?: string;
    message?: string;
  };
}

interface FailureContext {
  run_id: string;
  workflow_id: string;
  error_summary: string | null;
}

export async function notifyOnFailure(tenantId: string, ctx: FailureContext): Promise<void> {
  const cfgRow = await withTenant(tenantId, async (db) => {
    const { rows } = await db.query<{ config: FailureNotifyConfig }>(
      "SELECT config FROM connector_configs WHERE connector_type = 'failure_notify' LIMIT 1",
    );
    return rows[0]?.config ?? null;
  });
  if (!cfgRow) return; // tenant hasn't opted in

  const handler = getHandler("NOTIFY");
  if (!handler) {
    logger.warn("NotifyHandler not registered; skipping failure notification");
    return;
  }

  const cfg = loadConfig();
  const templateContext = {
    trigger: { payload: null },
    nodes: {},
    run: ctx, // bonus binding so users can reference {{run.id}} / {{run.error_summary}}
  };
  const rendered = renderDeep(
    {
      channel: cfgRow.channel,
      ...cfgRow.config,
      message:
        cfgRow.config.message ??
        `Run {{run.run_id}} of workflow {{run.workflow_id}} FAILED: {{run.error_summary}}`,
    },
    templateContext as Record<string, unknown>,
  ) as Record<string, unknown>;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    await handler.execute({
      inputs: templateContext as never,
      config: rendered,
      secrets: secretResolver(tenantId),
      idempotencyKey: `failure-notify:${ctx.run_id}`,
      timeoutMs: 10_000,
      signal: ac.signal,
      log: logger.child({ failure_notify: true, run_id: ctx.run_id }),
    });
  } catch (err) {
    logger.error({ err, run_id: ctx.run_id }, "failure-notify delivery failed");
  } finally {
    clearTimeout(t);
    void cfg; // satisfy "unused" if loadConfig() side-effects mattered
  }
}
