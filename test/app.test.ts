import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

describe("Fastify backend", () => {
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("serves the health contract without MongoDB configuration", async () => {
    const response = await app!.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    const root = await app!.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toEqual({
      status: "success",
      message: "Victory Fitness API is running",
    });
  });

  it("registers representative routes from every ported domain", () => {
    for (const [method, url] of [
      ["POST", "/auth/login"],
      ["GET", "/me/onboarding"],
      ["GET", "/workouts/library"],
      ["GET", "/community/posts"],
      ["GET", "/challenges/:challengeId"],
      ["GET", "/journal/entries"],
      ["POST", "/ai/nutrition/plan"],
      ["GET", "/longevity-os/dashboard"],
      ["GET", "/integrations"],
      ["GET", "/admin/users"],
    ] as const) {
      expect(app!.hasRoute({ method, url })).toBe(true);
    }
  });

  it("preserves FastAPI-style missing route errors", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/does-not-exist",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: "Not Found" });
  });
});
