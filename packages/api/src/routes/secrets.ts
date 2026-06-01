import { Router } from "express";
import { z } from "zod";
import { badRequest, notFound, secrets } from "@conduit/shared";
import { asyncHandler, requireAuth } from "../http.js";
import { requireRole } from "../middleware/auth.js";

export const secretsRouter = Router();

// Single source of truth for secret name validation — applied to BOTH POST
// (create) and DELETE (so a request like `DELETE /v1/secrets/../../etc` is
// rejected before it ever reaches the storage layer).
const NameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/, "name: alnum/._- only");

const PutBody = z.object({
  name: NameSchema,
  value: z.string().min(1),
});

// List names only — values are write-only (§7.1.2).
secretsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    res.json({ items: await secrets.listSecretNames(tenantId) });
  }),
);

// Create or rotate. admin-only.
secretsRouter.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const body = PutBody.parse(req.body);
    await secrets.putSecret(tenantId, body.name, body.value);
    res.status(201).json({ name: body.name, status: "stored" });
  }),
);

secretsRouter.delete(
  "/:name",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { tenantId } = requireAuth(req);
    const parsed = NameSchema.safeParse(req.params["name"]);
    if (!parsed.success) throw badRequest("invalid secret name");
    const ok = await secrets.deleteSecret(tenantId, parsed.data);
    if (!ok) throw notFound("secret not found");
    res.status(204).end();
  }),
);
