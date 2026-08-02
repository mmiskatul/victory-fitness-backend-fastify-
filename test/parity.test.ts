import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const canonical = (path: string) =>
  path.replace(/\{[^}]+\}/g, "{}").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}");

describe("FastAPI compatibility inventory", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => app.close());

  it("registers every HTTP method/path exposed by the FastAPI backend", async () => {
    const pythonRoot = resolve(
      import.meta.dirname,
      "..",
      "..",
      "victory-fitness-backend",
      "app",
    );
    const sources = await Promise.all([
      readFile(resolve(pythonRoot, "main.py"), "utf8"),
      readFile(resolve(pythonRoot, "wearables", "router.py"), "utf8"),
    ]);
    const expected = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(
        /@(app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g,
      )) {
        expected.add(`${match[2]!.toUpperCase()} ${canonical(match[3]!)}`);
      }
    }
    const openapi = app.swagger() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const actual = new Set<string>();
    for (const [path, operations] of Object.entries(openapi.paths)) {
      for (const method of Object.keys(operations)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) {
          actual.add(`${method.toUpperCase()} ${canonical(path)}`);
        }
      }
    }
    const missing = [...expected].filter((route) => !actual.has(route));
    expect(missing).toEqual([]);
    expect(expected.size).toBe(207);
  });

  it("keeps the challenge chat WebSocket route", () => {
    expect(
      app.hasRoute({ method: "GET", url: "/ws/challenges/:challengeId/chat" }),
    ).toBe(true);
  });

  it("protects scheduled jobs with the cron secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/jobs/nutrition",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ detail: "Invalid cron authorization" });
  });
});
