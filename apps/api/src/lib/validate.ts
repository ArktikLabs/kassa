import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { ZodIssue, ZodTypeAny, typeToFlattenedError } from "zod";
import { sendError } from "./errors.js";

/**
 * Per-source schema bundle. Each is an optional Zod schema; if provided the
 * validator parses the matching request property, replaces it with the parsed
 * value (so transforms / coercions are visible to handlers), and aggregates
 * issues from every source into a single 422 response.
 */
export interface ValidateSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export type ValidationSource = "body" | "query" | "params";

export interface ValidationIssue {
  source: ValidationSource;
  /** Dot-joined path inside the source (e.g. `items.0.priceIdr`); `""` if root. */
  path: string;
  message: string;
  code: string;
}

type FlattenedError = typeToFlattenedError<unknown, string>;

export interface ValidationDetails {
  issues: ValidationIssue[];
  body?: FlattenedError;
  query?: FlattenedError;
  params?: FlattenedError;
}

/**
 * Builds a Fastify `preHandler` that enforces Zod schemas on the request
 * body / query / params. Composes with other preHandlers via the array form
 * (auth first, then validate). On any failure it short-circuits with a 422
 * `validation_error` response carrying field-level issues; on success it
 * mutates `req.body` / `req.query` / `req.params` to the parsed values so
 * downstream handlers can rely on the typed shape.
 *
 * Usage:
 *   app.post(
 *     "/items",
 *     { preHandler: [requireStaff, validate({ body: itemCreateRequest })] },
 *     async (req, reply) => { ... },
 *   );
 */
export function validate(schemas: ValidateSchemas): preHandlerHookHandler {
  return async function validatePreHandler(req: FastifyRequest, reply: FastifyReply) {
    const issues: ValidationIssue[] = [];
    const details: ValidationDetails = { issues };

    if (schemas.body) {
      const parsed = schemas.body.safeParse(req.body);
      if (parsed.success) {
        req.body = parsed.data;
      } else {
        details.body = parsed.error.flatten();
        pushIssues(issues, "body", parsed.error.issues);
      }
    }

    if (schemas.query) {
      const parsed = schemas.query.safeParse(req.query);
      if (parsed.success) {
        req.query = parsed.data;
      } else {
        details.query = parsed.error.flatten();
        pushIssues(issues, "query", parsed.error.issues);
      }
    }

    if (schemas.params) {
      const parsed = schemas.params.safeParse(req.params);
      if (parsed.success) {
        req.params = parsed.data;
      } else {
        details.params = parsed.error.flatten();
        pushIssues(issues, "params", parsed.error.issues);
      }
    }

    if (issues.length > 0) {
      sendError(reply, 422, "validation_error", "Request failed validation.", details);
      return reply;
    }
    return undefined;
  };
}

function pushIssues(
  bucket: ValidationIssue[],
  source: ValidationSource,
  zodIssues: readonly ZodIssue[],
): void {
  for (const issue of zodIssues) {
    bucket.push({
      source,
      path: issue.path.map(String).join("."),
      message: issue.message,
      code: issue.code,
    });
  }
}
