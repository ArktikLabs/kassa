/*
 * Pure helpers exported from the service worker so unit tests can
 * assert their semantics without the cost of mocking the entire
 * workbox import graph that `sw.ts` pulls in at the top level.
 */

/*
 * Accepts both `MessageEvent` (window) and `ExtendableMessageEvent`
 * (service worker) by structurally typing the only field we care about.
 */
export function isSkipWaitingMessage(event: { data: unknown }): boolean {
  const data = event.data as { type?: unknown } | null | undefined;
  return Boolean(data && data.type === "SKIP_WAITING");
}
