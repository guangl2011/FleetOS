import fastify, { type FastifyInstance } from "fastify";

import { toApiError } from "./errors.js";
import { resolveApiOptions } from "./config.js";
import type { ApiOptions, ApiOptionsInput } from "./config.js";
import type { FleetOsRuntime } from "./runtime.js";
import { createFleetOsRuntime } from "./runtime.js";
import { registerRoutes } from "./routes.js";

export interface FleetOsApi {
  readonly app: FastifyInstance;
  readonly runtime: FleetOsRuntime;
  readonly options: ApiOptions;
  /** Closes the Fastify instance and disposes adapter subscriptions. */
  close(): Promise<void>;
}

/**
 * Builds the FleetOS API over a bootstrap store. The runtime subscribes to
 * adapter telemetry/fault streams at construction; `app.get("/")` returns the
 * service descriptor for smoke checks. Callers own the returned instance —
 * `listen` in production (`main.ts`), `inject` in tests.
 */
export async function buildApp(overrides: ApiOptionsInput = {}): Promise<FleetOsApi> {
  const options = resolveApiOptions(overrides);
  const runtime = await createFleetOsRuntime(options);
  const store = runtime.store;
  const app = fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const apiError = toApiError(error);
    reply.status(apiError.statusCode).send({
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details === undefined ? {} : { details: apiError.details }),
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "no such route" } });
  });

  app.get("/", () => ({
    service: "fleetos-api",
    version: "0.1.0",
    robots: store.robots().length,
    regions: runtime.allowedRegionList(),
  }));

  registerRoutes(app, runtime);

  return {
    app,
    runtime,
    options,
    close: async () => {
      await app.close();
      await runtime.close();
    },
  };
}
