import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getRefreshToken, getToken, setRefreshToken, setToken } from "./api";

interface JwtPayload {
  sub: string;
  tid: string;
  role: "admin" | "editor" | "viewer";
  exp: number;
}

interface AuthState {
  user: JwtPayload | null;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, tenantName: string): Promise<void>;
  logout(): Promise<void>;
  /** Plant tokens received from an external source (OAuth callback) and
   *  refresh the in-memory user immediately so routing flips this render. */
  applyTokens(access: string, refresh: string): void;
}

const Ctx = createContext<AuthState | null>(null);

function decode(token: string | null): JwtPayload | null {
  if (!token) return null;
  try {
    const [, b] = token.split(".");
    return JSON.parse(atob(b!.replace(/-/g, "+").replace(/_/g, "/"))) as JwtPayload;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<JwtPayload | null>(decode(getToken()));

  // Re-decode whenever localStorage is mutated by api.ts (transparent refresh
  // rotates the access token under us — we want the new exp/role to take).
  useEffect(() => {
    const t = setInterval(() => {
      const decoded = decode(getToken());
      setUser((prev) => (prev?.exp === decoded?.exp ? prev : decoded));
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      async login(email, password) {
        const r = await api.post<{ access_token: string; refresh_token: string }>(
          "/v1/auth/login",
          { email, password },
        );
        setToken(r.access_token);
        setRefreshToken(r.refresh_token);
        setUser(decode(r.access_token));
      },
      async register(email, password, tenant_name) {
        const r = await api.post<{ access_token: string; refresh_token: string }>(
          "/v1/auth/register",
          { email, password, tenant_name },
        );
        setToken(r.access_token);
        setRefreshToken(r.refresh_token);
        setUser(decode(r.access_token));
      },
      async logout() {
        // Best-effort server-side revoke of the refresh family.
        const r = getRefreshToken();
        if (r) await api.post("/v1/auth/logout", { refresh_token: r }).catch(() => {});
        setToken(null);
        setRefreshToken(null);
        setUser(null);
      },
      applyTokens(access, refresh) {
        setToken(access);
        setRefreshToken(refresh);
        setUser(decode(access));
      },
    }),
    [user],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider missing");
  return v;
}
