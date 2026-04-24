import { describe, expect, it } from "vitest";
import { isSkipWaitingMessage } from "../src/lib/sw-helpers";

function makeEvent(data: unknown): MessageEvent {
  return { data } as MessageEvent;
}

describe("isSkipWaitingMessage", () => {
  it("returns true for the contract Workbox-window posts", () => {
    expect(isSkipWaitingMessage(makeEvent({ type: "SKIP_WAITING" }))).toBe(true);
  });

  it("ignores unrelated message types so the SW does not auto-activate on stray traffic", () => {
    expect(isSkipWaitingMessage(makeEvent({ type: "WORKBOX_PRECACHE_UPDATE" }))).toBe(false);
    expect(isSkipWaitingMessage(makeEvent({ type: "skip_waiting" }))).toBe(false);
    expect(isSkipWaitingMessage(makeEvent({ skip: true }))).toBe(false);
  });

  it("does not throw on null / string / undefined data deliveries", () => {
    expect(isSkipWaitingMessage(makeEvent(null))).toBe(false);
    expect(isSkipWaitingMessage(makeEvent(undefined))).toBe(false);
    expect(isSkipWaitingMessage(makeEvent("SKIP_WAITING"))).toBe(false);
  });
});
