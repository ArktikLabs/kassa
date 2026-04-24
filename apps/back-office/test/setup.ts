import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetStore } from "../src/data/store";
import { clearSession } from "../src/lib/session";

window.scrollTo = (() => {}) as typeof window.scrollTo;

beforeEach(() => {
  localStorage.clear();
  clearSession();
  resetStore();
});

afterEach(() => {
  cleanup();
});
