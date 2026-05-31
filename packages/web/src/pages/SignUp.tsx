import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { SignUpSchema, type SignUpInput } from "@conduit/shared/schemas";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { GoogleButton } from "../components/GoogleButton";

export function SignUp(): JSX.Element {
  const { register: registerUser } = useAuth();
  const nav = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpInput>({
    resolver: zodResolver(SignUpSchema),
    mode: "onBlur",
    defaultValues: { tenant_name: "", email: "", password: "" },
  });

  async function onSubmit(values: SignUpInput): Promise<void> {
    setServerError(null);
    try {
      await registerUser(values.email, values.password, values.tenant_name);
      nav("/workflows", { replace: true });
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <>
      <div className="aurora" />
      <div className="auth-shell">
        <div className="auth-card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontWeight: 800,
              fontSize: 20,
              marginBottom: 24,
              letterSpacing: "-0.02em",
            }}
          >
            <Link
              to="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                borderRadius: 8,
                background: "linear-gradient(135deg, var(--brand-1), var(--brand-3))",
                color: "white",
                textDecoration: "none",
              }}
            >
              ◆
            </Link>
            <Link to="/" style={{ color: "var(--ink)", textDecoration: "none" }}>
              Conduit
            </Link>
          </div>
          <h1>Create your workspace</h1>
          <p className="sub">It&apos;s free to start. No credit card.</p>

          <GoogleButton mode="signup" />

          <div className="auth-divider">or with email</div>

          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="field">
              <label htmlFor="signup-tenant">Workspace name</label>
              <input
                id="signup-tenant"
                placeholder="Acme Inc."
                aria-invalid={!!errors.tenant_name}
                {...register("tenant_name")}
              />
              <div className="field-err">{errors.tenant_name?.message}</div>
            </div>
            <div className="field">
              <label htmlFor="signup-email">Email</label>
              <input
                id="signup-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                aria-invalid={!!errors.email}
                {...register("email")}
              />
              <div className="field-err">{errors.email?.message}</div>
            </div>
            <div className="field">
              <label htmlFor="signup-password">Password</label>
              <input
                id="signup-password"
                type="password"
                autoComplete="new-password"
                placeholder="At least 8 chars, mix letters and numbers"
                aria-invalid={!!errors.password}
                {...register("password")}
              />
              <div className="field-err">{errors.password?.message}</div>
            </div>
            {serverError && <div className="problem">{serverError}</div>}
            <button type="submit" className="btn-block" disabled={isSubmitting}>
              {isSubmitting ? "Creating workspace…" : "Create workspace"}
            </button>
          </form>

          <div className="footnote">
            Already have an account? <Link to="/sign-in">Sign in →</Link>
          </div>
        </div>
      </div>
    </>
  );
}
