import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export function Layout(): JSX.Element {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="mark">◆</span> Conduit
        </div>
        <div className="who">
          <span style={{ color: "var(--side-ink)", fontWeight: 600 }}>{user?.role}</span>
          {" · "}
          tenant {user?.tid.slice(0, 8)}
        </div>
        <nav>
          <NavLink to="/workflows" className={({ isActive }) => (isActive ? "active" : "")}>
            <span style={{ width: 18, textAlign: "center" }}>📋</span> Workflows
          </NavLink>
          <NavLink to="/runs" className={({ isActive }) => (isActive ? "active" : "")}>
            <span style={{ width: 18, textAlign: "center" }}>▶</span> Runs
          </NavLink>
          <NavLink to="/secrets" className={({ isActive }) => (isActive ? "active" : "")}>
            <span style={{ width: 18, textAlign: "center" }}>🔐</span> Secrets
          </NavLink>
          {user?.role === "admin" && (
            <NavLink to="/audit" className={({ isActive }) => (isActive ? "active" : "")}>
              <span style={{ width: 18, textAlign: "center" }}>📜</span> Audit log
            </NavLink>
          )}
        </nav>
        <div className="logout">
          <button
            className="ghost"
            onClick={async () => {
              await logout();
              nav("/");
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
