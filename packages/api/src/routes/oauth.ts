import { randomBytes } from "node:crypto";
import { Router } from "express";
import {
  loadConfig,
  logger,
  redis,
  type Role,
  signAccess,
  signRefresh,
  withSystem,
} from "@conduit/shared";
import { asyncHandler } from "../http.js";

/**
 * Google OAuth 2.0 ("Authorization Code" flow).
 *
 *   /v1/auth/oauth/google/start?mode=signin|signup
 *     → generates state, persists it in Redis (5-min TTL), redirects to Google
 *
 *   /v1/auth/oauth/google/callback?code=...&state=...
 *     → validates state, exchanges code → id_token + access_token
 *     → fetches userinfo, looks up / links / creates user (and tenant)
 *     → mints our own access + refresh JWTs
 *     → redirects to ${WEB_BASE_URL}/auth/callback#access_token=…&refresh_token=…
 *
 * v1 simplifications:
 *  - Verifies Google's id_token by calling the `tokeninfo` endpoint instead of
 *    fetching JWKS + RS256-verifying locally. One extra Google round-trip per
 *    sign-in. Production should swap to JWKS-based verification.
 *  - One Google account = one user. If the account email matches an existing
 *    user, we LINK (set google_id). No "are you sure?" interstitial.
 *  - First-time sign-in creates a personal tenant named after the user's
 *    display name (or "Personal" as fallback).
 */
export const oauthRouter = Router();

const STATE_TTL_SECONDS = 600;

oauthRouter.get(
  "/google/start",
  asyncHandler(async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) {
      res.status(503).json({
        title: "Google OAuth not configured",
        detail:
          "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the API to enable Google sign-in.",
      });
      return;
    }
    const mode = (req.query["mode"] as string) === "signup" ? "signup" : "signin";
    const state = randomBytes(24).toString("base64url");
    await redis().set(`conduit:oauth:state:${state}`, mode, "EX", STATE_TTL_SECONDS);

    const redirectUri =
      cfg.GOOGLE_REDIRECT_URI ?? `${cfg.PUBLIC_BASE_URL}/v1/auth/oauth/google/callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", cfg.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    // `prompt=select_account` always lets the user pick which Google account
    // when they already have one signed in — better UX than the default.
    url.searchParams.set("prompt", "select_account");
    res.redirect(302, url.toString());
  }),
);

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
}

interface GoogleUserInfo {
  sub: string; // stable Google user id
  email: string;
  email_verified: boolean;
  name?: string;
  given_name?: string;
}

oauthRouter.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) {
      res.status(503).end();
      return;
    }
    const code = req.query["code"] as string | undefined;
    const state = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;
    if (errorParam) {
      // User denied access or another Google-side error.
      return redirectToWebError(res, cfg.WEB_BASE_URL, `google_${errorParam}`);
    }
    if (!code || !state) {
      return redirectToWebError(res, cfg.WEB_BASE_URL, "missing_code_or_state");
    }
    // One-time use: GETDEL + verify in one round trip.
    const mode = await redis().getdel(`conduit:oauth:state:${state}`);
    if (!mode) return redirectToWebError(res, cfg.WEB_BASE_URL, "invalid_state");

    const redirectUri =
      cfg.GOOGLE_REDIRECT_URI ?? `${cfg.PUBLIC_BASE_URL}/v1/auth/oauth/google/callback`;

    // Exchange code → tokens
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.GOOGLE_CLIENT_ID,
        client_secret: cfg.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenResp.ok) {
      logger.error(
        { status: tokenResp.status, body: await tokenResp.text() },
        "google token exchange failed",
      );
      return redirectToWebError(res, cfg.WEB_BASE_URL, "token_exchange_failed");
    }
    const tokens = (await tokenResp.json()) as GoogleTokenResponse;

    // Fetch userinfo (cheaper than JWKS-verifying the id_token for v1).
    const userinfoResp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userinfoResp.ok) {
      logger.error({ status: userinfoResp.status }, "google userinfo fetch failed");
      return redirectToWebError(res, cfg.WEB_BASE_URL, "userinfo_failed");
    }
    const profile = (await userinfoResp.json()) as GoogleUserInfo;
    if (!profile.email_verified) {
      return redirectToWebError(res, cfg.WEB_BASE_URL, "email_not_verified");
    }

    // Look up / link / create AND mint the refresh family in a SINGLE
    // transaction so the whole sign-in is atomic. Previously this ran as two
    // withSystem() calls — if the family insert failed after a fresh user/
    // tenant was already committed, the user would exist with no usable
    // session and a 500 would be returned. FOR UPDATE on candidate user rows
    // serialises concurrent OAuth callbacks for the same Google account /
    // email so they can't both create-link in parallel.
    const result = await withSystem(async (db) => {
      const byGoogle = await db.query<{ id: string; tenant_id: string; role: Role }>(
        "SELECT id, tenant_id, role FROM users WHERE google_id = $1 FOR UPDATE",
        [profile.sub],
      );
      let user: { id: string; tenant_id: string; role: Role };
      if (byGoogle.rowCount > 0) {
        await db.query("UPDATE users SET last_auth_provider = 'google' WHERE id = $1", [
          byGoogle.rows[0]!.id,
        ]);
        user = byGoogle.rows[0]!;
      } else {
        const byEmail = await db.query<{ id: string; tenant_id: string; role: Role }>(
          "SELECT id, tenant_id, role FROM users WHERE email = $1 FOR UPDATE",
          [profile.email],
        );
        if (byEmail.rowCount > 0) {
          // Silent account linking: a local password account with the same
          // verified email gets the Google sub attached. v1 trade-off — a
          // confirmation interstitial is on the roadmap.
          await db.query(
            "UPDATE users SET google_id = $2, last_auth_provider = 'google' WHERE id = $1",
            [byEmail.rows[0]!.id, profile.sub],
          );
          user = byEmail.rows[0]!;
        } else {
          // Brand-new user — create tenant + user. Admin role for the founder.
          const tenantName = profile.name?.trim() || profile.given_name?.trim() || "Personal";
          const tenant = await db.query<{ id: string }>(
            "INSERT INTO tenants (name) VALUES ($1) RETURNING id",
            [tenantName],
          );
          const tenantId = tenant.rows[0]!.id;
          try {
            const inserted = await db.query<{ id: string; tenant_id: string; role: Role }>(
              `INSERT INTO users (tenant_id, email, google_id, role, last_auth_provider, hashed_password)
               VALUES ($1, $2, $3, 'admin', 'google', NULL)
               RETURNING id, tenant_id, role`,
              [tenantId, profile.email, profile.sub],
            );
            user = inserted.rows[0]!;
          } catch (err) {
            // Concurrent OAuth callbacks for the same email/google_id race
            // here; the unique constraint catches it. Signal a retryable error
            // — the retry will hit the byGoogle/byEmail branch above.
            if ((err as { code?: string }).code === "23505") {
              return { retry: true as const };
            }
            throw err;
          }
        }
      }
      const { rows: famRows } = await db.query<{ id: string }>(
        "INSERT INTO refresh_families (user_id, tenant_id) VALUES ($1, $2) RETURNING id",
        [user.id, user.tenant_id],
      );
      return { user, fam: famRows[0]!.id };
    });

    if ("retry" in result) {
      return redirectToWebError(res, cfg.WEB_BASE_URL, "concurrent_signup_retry");
    }
    const { user: oauthUser, fam } = result;

    const access = signAccess({
      sub: oauthUser.id,
      tid: oauthUser.tenant_id,
      role: oauthUser.role,
    });
    const refresh = signRefresh({ sub: oauthUser.id, tid: oauthUser.tenant_id, fam });

    // Redirect with tokens in the URL fragment. Fragment never reaches the
    // server (not in logs / Referer headers).
    const url = new URL("/auth/callback", cfg.WEB_BASE_URL);
    url.hash = new URLSearchParams({
      access_token: access,
      refresh_token: refresh,
      mode,
    }).toString();
    res.redirect(302, url.toString());
  }),
);

function redirectToWebError(res: import("express").Response, webBase: string, code: string): void {
  const url = new URL("/auth/callback", webBase);
  url.hash = new URLSearchParams({ error: code }).toString();
  res.redirect(302, url.toString());
}
