import type { FastifyInstance } from "fastify";
export default async function healthRoutes(
  app: FastifyInstance,
): Promise<void> {
  const faviconPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+JgVnAAAAAElFTkSuQmCC",
    "base64",
  );
  app.get("/favicon.png", async (_request, reply) =>
    reply.type("image/png").send(faviconPng),
  );
  app.get("/favicon.ico", async (_request, reply) =>
    reply.type("image/png").send(faviconPng),
  );
  app.get("/", async () => ({
    status: "success",
    message: "Victory Fitness API is running",
  }));
  app.get("/health", async () => ({ status: "ok" }));
}
