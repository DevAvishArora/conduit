import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, logger } from "@conduit/shared";

/** Terminal error handler — serialises everything as RFC 7807 problem+json. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let problem;
  if (err instanceof AppError) {
    problem = err.toProblem(req.originalUrl);
  } else if (err instanceof ZodError) {
    problem = {
      type: "about:blank",
      title: "Unprocessable Entity",
      status: 422,
      detail: "request validation failed",
      instance: req.originalUrl,
      errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  } else {
    logger.error({ err, path: req.originalUrl }, "unhandled error");
    problem = {
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      instance: req.originalUrl,
    };
  }
  res.status(problem.status).type("application/problem+json").json(problem);
}

export function notFoundHandler(req: Request, res: Response): void {
  res
    .status(404)
    .type("application/problem+json")
    .json({ type: "about:blank", title: "Not Found", status: 404, instance: req.originalUrl });
}
