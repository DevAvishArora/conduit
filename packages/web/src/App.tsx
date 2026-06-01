import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useAuth } from "./auth";
import { Audit } from "./pages/Audit";
import { AuthCallback } from "./pages/AuthCallback";
import { Home } from "./pages/Home";
import { RunDetail } from "./pages/RunDetail";
import { Runs } from "./pages/Runs";
import { Secrets } from "./pages/Secrets";
import { SignIn } from "./pages/SignIn";
import { SignUp } from "./pages/SignUp";
import { WorkflowDetail } from "./pages/WorkflowDetail";
import { Workflows } from "./pages/Workflows";

/**
 * Single Routes tree with route-level auth gates.
 *
 *  - `RequireGuest` wraps the public surfaces (/, /sign-in, /sign-up). If the
 *    user is already authenticated, they're sent straight to /workflows.
 *  - `RequireAuth` wraps the app surfaces. Unauthed visitors are bounced to
 *    /sign-in with the attempted URL preserved in `state.from` so we can
 *    return them there after sign-in.
 *  - /auth/callback is intentionally ungated — OAuth must land on it
 *    regardless of current auth state to plant tokens.
 *
 * Why one tree and not two: swapping <Routes> trees on `user` flip caused a
 * race where react-router's location update could land before the auth state
 * update, leaving us briefly rendering the unauthed tree against an authed
 * URL and bouncing through the catch-all. A single tree means matching is
 * stable and only the *element* is conditional.
 */
function RequireAuth(): JSX.Element {
  const { user } = useAuth();
  if (!user) return <Navigate to="/sign-in" replace />;
  return <Layout />;
}

function RequireGuest({ children }: { children: JSX.Element }): JSX.Element {
  const { user } = useAuth();
  if (user) return <Navigate to="/workflows" replace />;
  return children;
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <RequireGuest>
            <Home />
          </RequireGuest>
        }
      />
      <Route
        path="/sign-in"
        element={
          <RequireGuest>
            <SignIn />
          </RequireGuest>
        }
      />
      <Route
        path="/sign-up"
        element={
          <RequireGuest>
            <SignUp />
          </RequireGuest>
        }
      />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route element={<RequireAuth />}>
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/workflows/:id" element={<WorkflowDetail />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/secrets" element={<Secrets />} />
        <Route path="/audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Fallback />} />
    </Routes>
  );
}

function Fallback(): JSX.Element {
  const { user } = useAuth();
  return <Navigate to={user ? "/workflows" : "/"} replace />;
}
