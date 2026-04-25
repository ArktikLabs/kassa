/**
 * Page tokens for reference-data pull endpoints. Tokens are opaque
 * server-issued strings; the wire payload is `{ "a": <updated_at iso>,
 * "i": <uuid> }` base64url-encoded. The client only needs to round-trip them.
 *
 * Decoding validates shape so a tampered token surfaces as a typed
 * `InvalidPageTokenError` (handlers map it to 400) instead of leaking a
 * stack trace.
 */

export interface PageTokenPayload {
  a: string;
  i: string;
}

export class InvalidPageTokenError extends Error {
  constructor(message = "Malformed page token.") {
    super(message);
    this.name = "InvalidPageTokenError";
  }
}

export function encodePageToken(payload: PageTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePageToken(token: string): PageTokenPayload {
  let raw: string;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new InvalidPageTokenError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidPageTokenError();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).a !== "string" ||
    typeof (parsed as Record<string, unknown>).i !== "string"
  ) {
    throw new InvalidPageTokenError();
  }
  const payload = parsed as PageTokenPayload;
  if (Number.isNaN(Date.parse(payload.a))) {
    throw new InvalidPageTokenError();
  }
  return payload;
}
