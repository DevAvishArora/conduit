import nodemailer, { type Transporter } from "nodemailer";
import { httpRequest } from "./httpClient.js";
import { register } from "./registry.js";
import { FatalError, RetryableError, type ExecuteArgs, type NodeHandler } from "./types.js";

/**
 * NOTIFY connector (§6.5.2): Slack incoming-webhook or SMTP email.
 *  - Slack URL comes from a tenant SECRET (resolved here, never in snapshots).
 *  - Email uses SMTP_URL; without it we fall back to a JSON transport that
 *    logs the message (handy for local dev / tests).
 */
class NotifyHandler implements NodeHandler {
  readonly typeId = "NOTIFY" as const;
  private mailer: Transporter | null = null;

  async execute(args: ExecuteArgs): Promise<Record<string, unknown>> {
    const channel = String(args.config["channel"]);
    if (channel === "slack") return this.slack(args);
    if (channel === "email") return this.email(args);
    throw new FatalError(`unknown notify channel: ${channel}`);
  }

  private async slack(args: ExecuteArgs): Promise<Record<string, unknown>> {
    const secretName = args.config["webhook_url_secret"];
    const message = String(args.config["message"] ?? "");
    if (typeof secretName !== "string" || !secretName)
      throw new FatalError("slack notify requires config.webhook_url_secret");
    const webhookUrl = await args.secrets.get(secretName);

    const res = await httpRequest({
      method: "POST",
      url: webhookUrl,
      body: { text: message },
      timeoutMs: args.timeoutMs,
      signal: args.signal,
    });
    if (res.status === 429) throw new RetryableError("HTTP_429", "slack rate limited");
    if (res.status >= 500) throw new RetryableError("HTTP_5XX", `slack ${res.status}`);
    if (res.status >= 400) throw new FatalError(`slack ${res.status}: ${JSON.stringify(res.body)}`);
    return { channel: "slack", status: res.status };
  }

  private async email(args: ExecuteArgs): Promise<Record<string, unknown>> {
    const to = String(args.config["to"] ?? "");
    const subject = String(args.config["subject"] ?? "Flow notification");
    const message = String(args.config["message"] ?? "");
    if (!to) throw new FatalError("email notify requires config.to");

    const mailer = this.getMailer();
    try {
      const info = await mailer.sendMail({
        from: process.env.SMTP_FROM ?? "flow@localhost",
        to,
        subject,
        text: message,
      });
      return { channel: "email", message_id: info.messageId };
    } catch (err) {
      // SMTP failures are usually transient (greylisting, connection resets).
      throw new RetryableError("NETWORK_ERROR", (err as Error).message);
    }
  }

  private getMailer(): Transporter {
    if (this.mailer) return this.mailer;
    const url = process.env.SMTP_URL;
    this.mailer = url
      ? nodemailer.createTransport(url)
      : nodemailer.createTransport({ jsonTransport: true }); // dev fallback: logs
    return this.mailer;
  }
}

register(new NotifyHandler());
export { NotifyHandler };
