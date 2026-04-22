import type { FastifyReply } from "fastify";

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

export function notImplemented(reply: FastifyReply, endpoint: string): FastifyReply {
  return sendError(
    reply,
    501,
    "not_implemented",
    `Endpoint ${endpoint} is not implemented yet.`,
  );
}
