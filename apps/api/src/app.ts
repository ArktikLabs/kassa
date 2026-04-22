import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { registerRoutes } from "./routes/index.js";
import { sendError } from "./lib/errors.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    disableRequestLogging: false,
    trustProxy: true,
    ajv: {
      customOptions: { removeAdditional: "all", useDefaults: true },
    },
  });

  app.setNotFoundHandler((req, reply) => {
    sendError(reply, 404, "not_found", `No route for ${req.method} ${req.url}.`);
  });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error({ err }, "request failed");
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const code = status >= 500 ? "internal_error" : (err.code ?? "bad_request").toLowerCase();
    const message = status >= 500 ? "Internal server error." : err.message;
    sendError(reply, status, code, message);
  });

  await app.register(registerRoutes, { prefix: "/v1" });

  return app;
}
