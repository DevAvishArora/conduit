import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

/**
 * Landing route the OAuth callback redirects to.
 *
 * The API ends the OAuth dance with a 302 to
 *   `${WEB_BASE_URL}/auth/callback#access_token=…&refresh_token=…[&mode=…]`
 * Tokens travel in the URL fragment — not the query string — so they never
 * end up in server access logs or Referer headers.
 *
 * On mount we parse the fragment, plant the tokens into the auth context, and
 * route the user to /workflows. If the fragment carries `error=…` instead we
 * surface a readable message and a link back to sign in.
 */
const FRIENDLY_ERROR: Record<string, string> = {
  invalid_state: "Sign-in session expired. Please try again.",
  missing_code_or_state: "Google didn't return the expected response. Please try again.",
  token_exchange_failed: "Couldn't complete sign-in with Google. Please try again.",
  userinfo_failed: "Couldn't fetch your Google profile. Please try again.",
  email_not_verified: "Verify your email with Google first, then try again.",
  google_access_denied: "You declined Google access. No worries — try again or use email.",
};

export function AuthCallback(): JSX.Element {
  const { applyTokens } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const access = params.get("access_token");
    const refresh = params.get("refresh_token");
    const err = params.get("error");
    if (err) {
      setError(FRIENDLY_ERROR[err] ?? err);
      return;
    }
    if (!access || !refresh) {
      setError("Missing tokens in callback. Please sign in again.");
      return;
    }
    // Wipe the fragment immediately — leaving secrets sitting in the URL bar
    // is a small but real leak vector.
    window.history.replaceState(null, "", "/auth/callback");
    applyTokens(access, refresh);
    nav("/workflows", { replace: true });
  }, [applyTokens, nav]);

  return (
    <>
      <div className="aurora" />
      <div className="auth-shell">
        <div className="auth-card" style={{ textAlign: "center" }}>
          {error ? (
            <>
              <h1>Sign-in failed</h1>
              <p className="sub" style={{ marginBottom: 18 }}>
                {error}
              </p>
              <Link
                to="/sign-in"
                className="btn-block"
                style={{ display: "inline-block", textDecoration: "none" }}
              >
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1>Signing you in…</h1>
              <p className="sub">One moment while we hand you the keys.</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
