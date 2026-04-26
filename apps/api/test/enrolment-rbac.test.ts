import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { EnrolmentService, InMemoryEnrolmentRepository } from "../src/services/enrolment/index.js";

/*
 * KASA-123: enrolment-code issuance is privileged — anyone authenticated
 * being able to mint device credentials is a privilege-escalation vector.
 * This suite asserts `POST /v1/auth/enrolment-codes` is gated to
 * `owner`/`manager` via the same `allowedRoles` machinery that `catalog`
 * and `reconciliation` use.
 */

const STAFF_TOKEN = "test-staff-token-1234567890abcdef";
const OUTLET_ID = "01890abc-1234-7def-8000-000000000001";
const MERCHANT_ID = "01890abc-1234-7def-8000-000000000010";
const STAFF_USER_ID = "01890abc-1234-7def-8000-000000000020";

interface Harness {
  app: FastifyInstance;
}

async function setup(): Promise<Harness> {
  const repo = new InMemoryEnrolmentRepository();
  repo.seedOutlet({
    outlet: { id: OUTLET_ID, name: "Warung Bu Tini — Cikini" },
    merchant: { id: MERCHANT_ID, name: "Warung Bu Tini" },
  });
  const service = new EnrolmentService({ repository: repo });
  const app = await buildApp({
    enrolment: { service, staffBootstrapToken: STAFF_TOKEN },
  });
  await app.ready();
  return { app };
}

interface StaffHeaderOverrides {
  role?: string;
}

function staffHeaders(opts: StaffHeaderOverrides = {}): Record<string, string> {
  const out: Record<string, string> = {
    authorization: `Bearer ${STAFF_TOKEN}`,
    "x-staff-user-id": STAFF_USER_ID,
    "x-staff-merchant-id": MERCHANT_ID,
    "content-type": "application/json",
  };
  if (opts.role !== undefined) out["x-staff-role"] = opts.role;
  return out;
}

describe("POST /v1/auth/enrolment-codes RBAC — owner/manager only", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.app.close();
  });

  for (const role of ["cashier", "read_only"] as const) {
    it(`rejects role=${role} with 403 forbidden`, async () => {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/auth/enrolment-codes",
        headers: staffHeaders({ role }),
        payload: { outletId: OUTLET_ID },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
    });
  }

  it("rejects requests without X-Staff-Role with 400 bad_request", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/enrolment-codes",
      headers: staffHeaders(),
      payload: { outletId: OUTLET_ID },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("bad_request");
  });

  for (const role of ["owner", "manager"] as const) {
    it(`accepts role=${role} with 201 Created`, async () => {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/auth/enrolment-codes",
        headers: staffHeaders({ role }),
        payload: { outletId: OUTLET_ID },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { code: string };
      expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    });
  }
});
