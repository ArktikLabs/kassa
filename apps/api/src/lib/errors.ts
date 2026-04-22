import type { FastifyReply, FastifyRequest } from "fastify";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return reply.code(status).send(body);
}

export function notImplemented(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendError(
    reply,
    501,
    "not_implemented",
    `Endpoint ${req.method} ${req.url} is not implemented yet.`,
  );
}
