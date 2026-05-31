/**
 * RFC 7807 problem-details errors (§6.2.1). Thrown anywhere in the API; a
 * single Express error handler serialises them with the right status.
 */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [k: string]: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    title: string,
    detail?: string,
    opts: { type?: string; extra?: Record<string, unknown> } = {},
  ) {
    super(detail ?? title);
    this.name = "AppError";
    this.status = status;
    this.title = title;
    this.type = opts.type ?? "about:blank";
    this.extra = opts.extra ?? {};
  }

  toProblem(instance?: string): ProblemDetail {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.message,
      ...(instance ? { instance } : {}),
      ...this.extra,
    };
  }
}

export const badRequest = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(400, "Bad Request", detail, { extra });
export const unauthorized = (detail = "Authentication required") =>
  new AppError(401, "Unauthorized", detail);
export const forbidden = (detail = "Insufficient permissions") =>
  new AppError(403, "Forbidden", detail);
export const notFound = (detail = "Resource not found") => new AppError(404, "Not Found", detail);
export const conflict = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(409, "Conflict", detail, { extra });
export const unprocessable = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(422, "Unprocessable Entity", detail, { extra });
export const tooManyRequests = (detail = "Rate limit exceeded") =>
  new AppError(429, "Too Many Requests", detail);
