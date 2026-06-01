import { z } from "zod";

/**
 * Auth payload schemas — shared between the API (server-side parse) and the
 * web form components (react-hook-form via @hookform/resolvers/zod). Keeping
 * the constraints in one file means a stricter password policy or stricter
 * email format ships to client + server simultaneously.
 *
 * Error messages are user-facing — phrased for the field UI.
 */
const email = z
  .string({ required_error: "Email is required" })
  .min(1, "Email is required")
  .email("Enter a valid email address");

const password = z
  .string({ required_error: "Password is required" })
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password is too long")
  .refine((v) => /[a-z]/i.test(v) && /[0-9]/.test(v), {
    message: "Mix letters and numbers",
  });

const tenantName = z
  .string({ required_error: "Workspace name is required" })
  .trim()
  .min(2, "At least 2 characters")
  .max(60, "Workspace name is too long");

export const SignInSchema = z.object({ email, password });
export type SignInInput = z.infer<typeof SignInSchema>;

export const SignUpSchema = z.object({
  email,
  password,
  tenant_name: tenantName,
});
export type SignUpInput = z.infer<typeof SignUpSchema>;

export const RefreshSchema = z.object({
  refresh_token: z.string().min(1),
});
