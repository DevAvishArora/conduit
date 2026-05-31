import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { SignInSchema, type SignInInput } from "@conduit/shared/schemas";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { GoogleButton } from "../components/GoogleButton";

export function SignIn(): JSX.Element {
  const { login } = useAuth();
  const nav = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(SignInSchema),
    mode: "onBlur",
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: SignInInput): Promise<void> {
    setServerError(null);
    try {
      await login(values.email, values.password);
      // `replace` so the back button can't return to /sign-in (which would
      // immediately bounce forward via the RequireGuest gate — confusing UX).
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
          <h1>Welcome back</h1>
          <p className="sub">Sign in to your workspace to manage workflows.</p>

          <GoogleButton mode="signin" />

          <div className="auth-divider">or with email</div>

          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="field">
              <label htmlFor="signin-email">Email</label>
              <input
                id="signin-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                aria-invalid={!!errors.email}
                {...register("email")}
              />
              <div className="field-err">{errors.email?.message}</div>
            </div>
            <div className="field">
              <label htmlFor="signin-password">Password</label>
              <input
                id="signin-password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                aria-invalid={!!errors.password}
                {...register("password")}
              />
              <div className="field-err">{errors.password?.message}</div>
            </div>
            {serverError && <div className="problem">{serverError}</div>}
            <button type="submit" className="btn-block" disabled={isSubmitting}>
              {isSubmitting ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="footnote">
            New to Conduit? <Link to="/sign-up">Create a workspace →</Link>
          </div>
        </div>
      </div>
    </>
  );
}
