// jest-dom matchers (toBeInTheDocument, toBeEnabled, …) for every console test.
import "@testing-library/jest-dom/vitest";

// RTL's auto-cleanup registers itself on a global afterEach, which only exists
// with vitest `globals: true` — we import matchers explicitly, so cleanup must
// be explicit or the DOM leaks across tests ("Found multiple elements").
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
