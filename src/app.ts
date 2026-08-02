import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { MongoServerError } from "mongodb";
import bcrypt from "bcryptjs";
import {
  config,
  defaultCorsOriginPattern,
  defaultCorsOrigins,
} from "./config.js";
import databasePlugin from "./db.js";
import { AppError } from "./lib/errors.js";
import { serialize } from "./lib/serialize.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import userRoutes from "./routes/users.js";
import contentRoutes from "./routes/content.js";
import communityRoutes from "./routes/community.js";
import workoutRoutes from "./routes/workouts.js";
import challengeRoutes from "./routes/challenges.js";
import journalAiRoutes from "./routes/journal-ai.js";
import adminLongevityRoutes from "./routes/admin-longevity.js";
import wearableRoutes from "./routes/wearables.js";
import jobsAdminRoutes from "./routes/jobs-admin.js";
import analyticsRoutes from "./routes/analytics.js";
import { startWearableWorkers } from "./services/wearable-sync.js";

const allowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true;
  const configured = config.corsOrigin
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (config.corsAllowAll || configured.includes("*")) {
    return (
      defaultCorsOrigins.includes(origin) ||
      defaultCorsOriginPattern.test(origin)
    );
  }
  if (configured.includes(origin)) return true;
  if (config.corsOriginRegex) {
    try {
      return new RegExp(config.corsOriginRegex).test(origin);
    } catch {
      return false;
    }
  }
  return false;
};

const canonicalRoute = (method: string, url: string) =>
  `${method.toUpperCase()} ${url.replace(/:[^/]+/g, "{}").replace(/\/$/, "") || "/"}`;
const snakeCase = (value: string) =>
  value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const optionalUnionParameter = (name: string, location = "query") => ({
  name,
  in: location,
  required: false,
  schema: { anyOf: [{ type: "string" }, { type: "null" }] },
});
const parameter = (
  name: string,
  location: string,
  type: string,
  required = false,
) => ({ name, in: location, required, schema: { type } });

const publicApiRoutes = new Set([
  "GET /integrations/{}/callback",
  "POST /webhooks/fitbit",
  "POST /webhooks/google-fit",
  "GET /wearables/fitbit/callback",
  "GET /wearables/google-fit/callback",
  "GET /wearables/garmin/callback",
  "POST /wearables/garmin/webhook",
  "GET /favicon.ico",
  "GET /favicon.png",
  "GET /",
  "GET /health",
  "GET /workouts/library",
  "POST /auth/register",
  "POST /auth/resend-verification",
  "POST /auth/verify-email",
  "POST /auth/forgot-password",
  "POST /auth/verify-reset-code",
  "POST /auth/reset-password",
  "POST /auth/login",
  "POST /auth/firebase",
  "POST /auth/google",
  "POST /auth/refresh",
  "POST /auth/logout",
  "POST /jobs/trial-campaign",
  "POST /jobs/nutrition",
  "GET /content/privacy-policy",
  "GET /content/about-us",
  "GET /content/onboarding",
  "GET /subscription-plans",
  "GET /content/homepage/quote",
]);
const routesWithoutValidationResponse = new Set([
  "POST /webhooks/fitbit",
  "POST /webhooks/google-fit",
  "GET /favicon.ico",
  "GET /favicon.png",
  "GET /",
  "GET /health",
  "GET /content/privacy-policy",
  "GET /content/about-us",
  "GET /content/onboarding",
  "GET /subscription-plans",
  "GET /content/homepage/quote",
]);
const nonDefaultSuccessStatus = new Map<string, number>([
  ["POST /auth/register", 202],
  ["POST /auth/resend-verification", 202],
  ["POST /admin/faqs", 201],
  ["POST /admin/subscription-plans", 201],
  ["POST /admin/masterclasses", 201],
  ["POST /applications", 201],
  ["POST /support/messages", 201],
  ["POST /community/posts", 201],
  ["DELETE /community/posts/{}", 204],
  ["POST /community/posts/{}/comments", 201],
  ["POST /admin/community/posts", 201],
  ["POST /admin/community/broadcast", 201],
  ["DELETE /admin/community/posts/{}", 204],
  ["POST /challenges/{}/chat/messages", 201],
  ["DELETE /challenges/{}/chat/messages/{}", 204],
  ["POST /challenges/{}/progress", 201],
  ["POST /challenges/{}/start", 201],
  ["POST /admin/challenges", 201],
  ["DELETE /admin/challenges/{}/chat/messages/{}", 204],
  ["POST /admin/workouts", 201],
  ["POST /journal/entries", 201],
  ["DELETE /journal/entries/{}", 204],
  ["POST /ai/nutrition/plan/jobs", 202],
  ["POST /ai/nutrition/plan/progressive/jobs", 202],
]);
const documentedParameters = new Map<string, Array<Record<string, any>>>([
  [
    "POST /admin/wearables/backfill-current-health-metrics",
    [parameter("force", "query", "boolean")],
  ],
  [
    "GET /integrations/{}/callback",
    [
      parameter("code", "query", "string", true),
      parameter("state", "query", "string", true),
    ],
  ],
  ...[
    "GET /wearables/fitbit/callback",
    "GET /wearables/google-fit/callback",
    "GET /wearables/garmin/callback",
  ].map(
    (key) =>
      [
        key,
        [
          parameter("code", "query", "string", true),
          parameter("state", "query", "string", true),
        ],
      ] as [string, Array<Record<string, any>>],
  ),
  ...["GET /health-data/me", "GET /health-data/me/summary"].map(
    (key) =>
      [
        key,
        ["end_date", "metric_type", "provider", "start_date", "user_id"].map(
          (name) => optionalUnionParameter(name),
        ),
      ] as [string, Array<Record<string, any>>],
  ),
  [
    "GET /health-data/me/{}",
    [["end_date", "provider", "start_date", "user_id"]]
      .flat()
      .map((name) => optionalUnionParameter(name)),
  ],
  ["GET /workouts/library", [optionalUnionParameter("query")]],
  [
    "GET /ai/workout-plan/strength/{}/report",
    [
      parameter("day", "query", "string"),
      parameter("full_plan", "query", "boolean"),
    ],
  ],
  ["POST /auth/login", [optionalUnionParameter("X-Victory-Client", "header")]],
  [
    "POST /auth/refresh",
    [
      optionalUnionParameter("session_token", "cookie"),
      optionalUnionParameter("X-Victory-Client", "header"),
    ],
  ],
  [
    "POST /auth/logout",
    [
      optionalUnionParameter("session_token", "cookie"),
      optionalUnionParameter("X-Victory-Client", "header"),
      optionalUnionParameter("authorization", "header"),
    ],
  ],
  [
    "POST /jobs/trial-campaign",
    [optionalUnionParameter("authorization", "header")],
  ],
  [
    "POST /jobs/nutrition",
    [
      optionalUnionParameter("authorization", "header"),
      parameter("limit", "query", "integer"),
    ],
  ],
  ...["GET /admin/subscribers", "GET /admin/users"].map(
    (key) =>
      [
        key,
        [
          parameter("limit", "query", "integer"),
          parameter("page", "query", "integer"),
          optionalUnionParameter("query"),
        ],
      ] as [string, Array<Record<string, any>>],
  ),
  [
    "GET /community/posts",
    [
      parameter("limit", "query", "integer"),
      parameter("page", "query", "integer"),
    ],
  ],
  ...["GET /admin/community/posts", "GET /admin/community/feed"].map(
    (key) =>
      [
        key,
        [
          parameter("limit", "query", "integer"),
          parameter("page", "query", "integer"),
          parameter("search", "query", "string"),
        ],
      ] as [string, Array<Record<string, any>>],
  ),
  ["GET /admin/challenges", [optionalUnionParameter("query")]],
  ["GET /admin/dashboard/overview", [optionalUnionParameter("year")]],
  ["GET /admin/users/summary", [optionalUnionParameter("year")]],
  [
    "GET /admin/user-management",
    [
      parameter("limit", "query", "integer"),
      parameter("page", "query", "integer"),
      optionalUnionParameter("query"),
      optionalUnionParameter("year"),
    ],
  ],
  ...[
    "GET /admin/trials/dropouts",
    "GET /admin/workouts/sync/debug",
    "GET /admin/audit-logs",
  ].map(
    (key) =>
      [key, [parameter("limit", "query", "integer")]] as [
        string,
        Array<Record<string, any>>,
      ],
  ),
  ["GET /admin/workouts", [optionalUnionParameter("query")]],
  ...[
    "GET /admin/dashboard/user-statistics",
    "GET /admin/dashboard/workout-statistics",
  ].map(
    (key) =>
      [key, [parameter("period", "query", "integer")]] as [
        string,
        Array<Record<string, any>>,
      ],
  ),
]);
const optionalRequestBodyRoutes = new Set([
  "POST /longevity-os/wearables/sync",
  "POST /auth/refresh",
  "POST /auth/logout",
]);

async function seedAdmin(app: FastifyInstance): Promise<void> {
  if (
    !app.mongo.configured ||
    !config.admin.seedEnabled ||
    !config.admin.password
  ) {
    return;
  }
  const users = app.mongo.collection("users");
  const existing = await users.findOne({ email: config.admin.email });
  const now = new Date();
  const passwordHash =
    !existing || config.admin.seedSyncPassword
      ? await bcrypt.hash(config.admin.password, 12)
      : undefined;
  await users.updateOne(
    { email: config.admin.email },
    {
      $set: {
        name: config.admin.name,
        email: config.admin.email,
        is_verified: true,
        is_admin: true,
        role: "admin",
        updated_at: now,
        ...(passwordHash ? { password_hash: passwordHash } : {}),
      },
      $setOnInsert: { created_at: now, auth_session_version: 0 },
    },
    { upsert: true },
  );
}

export async function buildApp(
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      request.rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  await app.register(sensible);
  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, allowedOrigin(origin)),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 100 },
  });
  await app.register(websocket);
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitTtl * 1000,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: config.appName, version: "1.0.0" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transformObject: (document: any) => {
      const openapiObject = document.openapiObject as Record<string, any>;
      const paths = openapiObject.paths ?? {};
      for (const [path, pathItem] of Object.entries(paths)) {
        const normalizedPath = path.replace(
          /\{([^}]+)\}/g,
          (_match, name) => `{${snakeCase(String(name))}}`,
        );
        for (const [method, rawOperation] of Object.entries(pathItem ?? {})) {
          if (!["get", "post", "put", "patch", "delete"].includes(method)) {
            continue;
          }
          const operation = rawOperation as Record<string, any>;
          const parameters = Array.isArray(operation.parameters)
            ? operation.parameters
            : [];
          for (const parameter of parameters) {
            if (parameter.in === "path") {
              parameter.name = snakeCase(parameter.name);
              if (parameter.name === "day_number") {
                parameter.schema = { type: "integer" };
              }
            }
          }
          const key = canonicalRoute(method, path.replace(/\{[^}]+\}/g, ":id"));
          for (const extra of documentedParameters.get(key) ?? []) {
            if (
              !parameters.some(
                (existing) =>
                  existing.in === extra.in && existing.name === extra.name,
              )
            ) {
              parameters.push(extra);
            }
          }
          if (!publicApiRoutes.has(key)) {
            parameters.push({
              name: "access_token",
              in: "cookie",
              required: false,
              schema: { anyOf: [{ type: "string" }, { type: "null" }] },
            });
          }
          operation.parameters = parameters;
          if (optionalRequestBodyRoutes.has(key) && operation.requestBody) {
            operation.requestBody.required = false;
          }
        }
        if (normalizedPath !== path) {
          paths[normalizedPath] = pathItem;
          delete paths[path];
        }
      }
      return openapiObject;
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(databasePlugin);
  await app.register(authPlugin);

  app.addHook("onRequest", async (request) => {
    request.requestStartedAt = Date.now();
  });
  app.addHook("onResponse", async (request, reply) => {
    const elapsed = Date.now() - (request.requestStartedAt ?? Date.now());
    const level = elapsed >= config.slowRequestThresholdMs ? "warn" : "info";
    request.log[level](
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        elapsed,
      },
      "request",
    );
  });
  app.addHook("preSerialization", async (_request, _reply, payload) =>
    serialize(payload),
  );

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        detail: error.detail,
        ...(error.code ? { code: error.code } : {}),
      });
    }
    if ("validation" in error && error.validation) {
      return reply.code(422).send({
        detail: error.validation.map((item: any) => ({
          type: item.keyword,
          loc: [
            "body",
            ...(item.instancePath?.split("/").filter(Boolean) ?? []),
          ],
          msg: item.message,
          input: null,
        })),
      });
    }
    if (error instanceof MongoServerError && error.code === 11000) {
      return reply.code(409).send({ detail: "Resource already exists" });
    }
    request.log.error({ err: error }, "request failed");
    return reply
      .code(Number((error as { statusCode?: number }).statusCode ?? 500))
      .send({
        detail:
          Number((error as { statusCode?: number }).statusCode ?? 500) < 500
            ? error.message
            : "Internal server error",
      });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ detail: "Not Found" }),
  );

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const method = methods.find((value) => value !== "HEAD") ?? methods[0];
    if (!method) return;
    const key = canonicalRoute(String(method), route.url);
    route.schema ??= {};
    (route.schema as any).security = publicApiRoutes.has(key)
      ? []
      : [{ bearerAuth: [] }];
    const success = nonDefaultSuccessStatus.get(key) ?? 200;
    const responses: Record<number, Record<string, never>> = { [success]: {} };
    if (!routesWithoutValidationResponse.has(key)) responses[422] = {};
    route.schema.response = {
      ...(route.schema.response ?? {}),
      ...responses,
    };
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(contentRoutes);
  await app.register(workoutRoutes);
  await app.register(communityRoutes);
  await app.register(challengeRoutes);
  await app.register(journalAiRoutes);
  await app.register(adminLongevityRoutes);
  await app.register(wearableRoutes);
  await app.register(jobsAdminRoutes);
  await app.register(analyticsRoutes);
  await seedAdmin(app);
  startWearableWorkers(app);
  return app;
}
