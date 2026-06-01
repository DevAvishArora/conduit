import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount every component between tests so leaks don't bleed across.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
