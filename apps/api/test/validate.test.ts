import { describe, expect, it } from "vitest";
import Fastify, { type FastifyError } from "fastify";
import { z } from "zod";
import { sendError } from "../src/lib/errors.js";
import { validate, type ValidationDetails } from "../src/lib/validate.js";

interface ErrorBody {
  error: { code: string; message: string; details: ValidationDetails };
}

function buildHarness() {
  const app = Fastify({ logger: false });
  // Mirror the production error shape for the rare unhandled failure path so
  // assertions don't depend on the full app builder for these unit tests.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    sendError(reply, status, err.code ?? "internal_error", err.message);
  });
  return app;
}

describe("validate() middleware", () => {
  it("passes a valid body, mutates req.body to the parsed value, and reaches the handler", async () => {
    const schema = z
      .object({
        amount: z.coerce.number().int().positive(),
        note: z.string().min(1).optional(),
      })
      .strict();
    const app = buildHarness();
    let observed: unknown = null;
    app.post("/echo", { preHandler: validate({ body: schema }) }, async (req, reply) => {
      observed = req.body;
      reply.code(200).send({ ok: true });
    });

    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: { amount: "42", note: "hello" },
    });

    expect(res.statusCode).toBe(200);
    // `coerce.number()` ran, so the handler sees a real number.
    expect(observed).toEqual({ amount: 42, note: "hello" });
    await app.close();
  });

  it("returns 422 validation_error with field-level issues for an invalid body", async () => {
    const schema = z
      .object({
        items: z
          .array(
            z.object({
              priceIdr: z.number().int().nonnegative(),
              code: z.string().min(1),
            }),
          )
          .min(1),
      })
      .strict();
    const app = buildHarness();
    app.post("/order", { preHandler: validate({ body: schema }) }, async () => ({ ok: true }));

    const res = await app.inject({
      method: "POST",
      url: "/order",
      headers: { "content-type": "application/json" },
      payload: { items: [{ priceIdr: -1, code: "" }] },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toMatch(/validation/i);

    const paths = body.error.details.issues.map((i) => `${i.source}:${i.path}`);
    expect(paths).toContain("body:items.0.priceIdr");
    expect(paths).toContain("body:items.0.code");
    for (const issue of body.error.details.issues) {
      expect(issue.source).toBe("body");
      expect(typeof issue.message).toBe("string");
      expect(typeof issue.code).toBe("string");
    }
    expect(body.error.details.body).toBeDefined();
    await app.close();
  });

  it("rejects unknown fields when the schema is strict()", async () => {
    const schema = z.object({ a: z.string() }).strict();
    const app = buildHarness();
    app.post("/strict", { preHandler: validate({ body: schema }) }, async () => ({ ok: true }));

    const res = await app.inject({
      method: "POST",
      url: "/strict",
      headers: { "content-type": "application/json" },
      payload: { a: "ok", b: "nope" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody;
    const codes = body.error.details.issues.map((i) => i.code);
    expect(codes).toContain("unrecognized_keys");
    await app.close();
  });

  it("validates query params and replaces req.query with the coerced value", async () => {
    const schema = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        outlet: z.string().min(1),
      })
      .strict();
    const app = buildHarness();
    let observed: unknown = null;
    app.get("/list", { preHandler: validate({ query: schema }) }, async (req, reply) => {
      observed = req.query;
      reply.code(200).send({ ok: true });
    });

    const ok = await app.inject({ method: "GET", url: "/list?outlet=outlet-1&limit=25" });
    expect(ok.statusCode).toBe(200);
    expect(observed).toEqual({ outlet: "outlet-1", limit: 25 });

    const missing = await app.inject({ method: "GET", url: "/list" });
    expect(missing.statusCode).toBe(422);
    const missingBody = missing.json() as ErrorBody;
    const sources = missingBody.error.details.issues.map((i) => i.source);
    expect(sources).toEqual(["query"]);
    expect(missingBody.error.details.issues[0]?.path).toBe("outlet");

    const tooBig = await app.inject({ method: "GET", url: "/list?outlet=x&limit=9999" });
    expect(tooBig.statusCode).toBe(422);
    expect((tooBig.json() as ErrorBody).error.details.issues[0]?.source).toBe("query");
    await app.close();
  });

  it("validates path params, e.g. UUIDs", async () => {
    const schema = z.object({ id: z.string().uuid() });
    const app = buildHarness();
    app.get<{ Params: { id: string } }>(
      "/items/:id",
      { preHandler: validate({ params: schema }) },
      async (_req, reply) => {
        reply.code(200).send({ ok: true });
      },
    );

    const ok = await app.inject({
      method: "GET",
      url: "/items/01890abc-1234-7def-8000-000000000001",
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({ method: "GET", url: "/items/not-a-uuid" });
    expect(bad.statusCode).toBe(422);
    const body = bad.json() as ErrorBody;
    expect(body.error.details.issues[0]?.source).toBe("params");
    expect(body.error.details.issues[0]?.path).toBe("id");
    await app.close();
  });

  it("aggregates issues across body, query, and params in a single 422", async () => {
    const app = buildHarness();
    app.post<{ Params: { id: string }; Querystring: { mode: string } }>(
      "/things/:id",
      {
        preHandler: validate({
          body: z.object({ name: z.string().min(1) }).strict(),
          query: z.object({ mode: z.enum(["a", "b"]) }).strict(),
          params: z.object({ id: z.string().uuid() }),
        }),
      },
      async (_req, reply) => {
        reply.code(200).send({ ok: true });
      },
    );

    const res = await app.inject({
      method: "POST",
      url: "/things/not-a-uuid?mode=zzz",
      headers: { "content-type": "application/json" },
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody;
    const sources = new Set(body.error.details.issues.map((i) => i.source));
    expect(sources).toEqual(new Set(["body", "query", "params"]));
    expect(body.error.details.body).toBeDefined();
    expect(body.error.details.query).toBeDefined();
    expect(body.error.details.params).toBeDefined();
    await app.close();
  });

  it("composes after another preHandler — validate runs only after auth passes", async () => {
    const app = buildHarness();
    app.post(
      "/auth-then-validate",
      {
        preHandler: [
          async (req, reply) => {
            if (req.headers.authorization !== "Bearer ok") {
              sendError(reply, 401, "unauthorized", "auth required.");
              return reply;
            }
            return undefined;
          },
          validate({ body: z.object({ a: z.string() }).strict() }),
        ],
      },
      async () => ({ ok: true }),
    );

    // Auth fails first — body is invalid, but the 401 from the auth preHandler
    // wins because preHandlers short-circuit when the reply is sent.
    const unauth = await app.inject({
      method: "POST",
      url: "/auth-then-validate",
      headers: { "content-type": "application/json" },
      payload: { not_a: "wrong" },
    });
    expect(unauth.statusCode).toBe(401);
    expect((unauth.json() as { error: { code: string } }).error.code).toBe("unauthorized");

    // Auth passes — now validate kicks in and rejects the bad body.
    const validatedBad = await app.inject({
      method: "POST",
      url: "/auth-then-validate",
      headers: { "content-type": "application/json", authorization: "Bearer ok" },
      payload: { not_a: "wrong" },
    });
    expect(validatedBad.statusCode).toBe(422);
    expect((validatedBad.json() as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );

    // Auth passes and body is valid — handler runs.
    const ok = await app.inject({
      method: "POST",
      url: "/auth-then-validate",
      headers: { "content-type": "application/json", authorization: "Bearer ok" },
      payload: { a: "ok" },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});
