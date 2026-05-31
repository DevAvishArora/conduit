/**
 * "Continue with Google" — kicks off the OAuth2 dance against the API.
 *
 * The browser navigates to /v1/auth/oauth/google/start; the backend redirects
 * to Google; Google redirects back to /v1/auth/oauth/google/callback; the
 * backend stamps a one-time exchange token and redirects to /auth/callback
 * on the frontend with the tokens in the URL fragment. AuthCallback parses
 * + stores them and routes the user into the app.
 *
 * The `mode` is sent so the API can render a sensible message if Google
 * tells us the account is new vs. existing.
 */
export function GoogleButton({ mode }: { mode: "signin" | "signup" }): JSX.Element {
  function onClick(): void {
    const url = `/v1/auth/oauth/google/start?mode=${mode}`;
    window.location.assign(url);
  }
  return (
    <button type="button" className="btn-google" onClick={onClick}>
      <GoogleMark />
      {mode === "signin" ? "Continue with Google" : "Sign up with Google"}
    </button>
  );
}

function GoogleMark(): JSX.Element {
  // Official multi-colour Google "G" mark in SVG.
  return (
    <svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.71v2.25h2.9c1.7-1.57 2.69-3.88 2.69-6.61z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.81.54-1.85.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC04"
        d="M3.95 10.71A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l2.99-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.97 8.97 0 0 0 9 0 9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58z"
      />
    </svg>
  );
}
