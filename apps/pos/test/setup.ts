import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

window.scrollTo = (() => {}) as typeof window.scrollTo;
