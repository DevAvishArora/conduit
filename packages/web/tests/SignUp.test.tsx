import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SignUp } from "../src/pages/SignUp";

const login = vi.fn(async () => {});
const register = vi.fn(async () => {});

vi.mock("../src/auth", () => ({
  useAuth: () => ({ login, register, logout: vi.fn(), applyTokens: vi.fn(), user: null }),
}));

function setup(): void {
  render(
    <MemoryRouter>
      <SignUp />
    </MemoryRouter>,
  );
}

describe("<SignUp />", () => {
  it("renders workspace + email + password fields and the Google button", () => {
    setup();
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign up with google/i })).toBeInTheDocument();
  });

  it("requires a workspace name with at least 2 characters", async () => {
    const user = userEvent.setup();
    register.mockClear();
    setup();
    await user.type(screen.getByLabelText(/workspace name/i), "X");
    await user.type(screen.getByLabelText(/email/i), "a@b.dev");
    await user.type(screen.getByLabelText(/password/i), "password12");
    await user.click(screen.getByRole("button", { name: /create workspace/i }));
    expect(await screen.findByText(/at least 2/i)).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it("requires the password to mix letters and digits", async () => {
    const user = userEvent.setup();
    register.mockClear();
    setup();
    await user.type(screen.getByLabelText(/workspace name/i), "Acme Inc");
    await user.type(screen.getByLabelText(/email/i), "a@b.dev");
    await user.type(screen.getByLabelText(/password/i), "alllettersxx"); // no digits
    await user.click(screen.getByRole("button", { name: /create workspace/i }));
    expect(await screen.findByText(/mix letters and numbers/i)).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it("invokes auth.register with all three fields on success", async () => {
    const user = userEvent.setup();
    register.mockClear();
    setup();
    await user.type(screen.getByLabelText(/workspace name/i), "Acme Inc");
    await user.type(screen.getByLabelText(/email/i), "ceo@acme.dev");
    await user.type(screen.getByLabelText(/password/i), "password12");
    await user.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() =>
      expect(register).toHaveBeenCalledWith("ceo@acme.dev", "password12", "Acme Inc"),
    );
  });
});
