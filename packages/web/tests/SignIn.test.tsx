import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SignIn } from "../src/pages/SignIn";

const login = vi.fn(async () => {});
const register = vi.fn(async () => {});

vi.mock("../src/auth", () => ({
  useAuth: () => ({ login, register, logout: vi.fn(), applyTokens: vi.fn(), user: null }),
}));

function setup(): void {
  render(
    <MemoryRouter>
      <SignIn />
    </MemoryRouter>,
  );
}

describe("<SignIn />", () => {
  it("renders email + password fields and a Continue with Google button", () => {
    setup();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("shows inline zod errors for invalid email / short password without hitting the server", async () => {
    const user = userEvent.setup();
    login.mockClear();
    setup();
    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(await screen.findByText(/at least 8/i)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("invokes auth.login with the entered credentials on a valid submission", async () => {
    const user = userEvent.setup();
    login.mockClear();
    setup();
    await user.type(screen.getByLabelText(/email/i), "a@b.dev");
    await user.type(screen.getByLabelText(/password/i), "password12");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("a@b.dev", "password12"));
  });

  it("surfaces a server error inline when login rejects", async () => {
    const user = userEvent.setup();
    login.mockRejectedValueOnce(new Error("invalid credentials"));
    setup();
    await user.type(screen.getByLabelText(/email/i), "a@b.dev");
    await user.type(screen.getByLabelText(/password/i), "password12");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
  });
});
