import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ObjectId, type Document } from "mongodb";
import { config } from "../config.js";
import { forbidden, unauthorized } from "../lib/errors.js";

export type AuthUser = Document & {
  _id: ObjectId;
  email: string;
  is_verified: boolean;
  is_admin?: boolean;
  auth_session_version?: number;
};

export const subscriptionAccess: Record<string, string[]> = {
  NONE: [],
  SILVER: ["home", "workout", "challenge", "community", "profile"],
  GOLD: ["home", "workout", "challenge", "community", "mealPlan", "profile"],
  PLATINUM: [
    "home",
    "workout",
    "challenge",
    "community",
    "mealPlan",
    "nutrition_tracker",
    "meal_analysis",
    "profile",
    "workoutplan",
    "longevity",
  ],
  INNER_CIRCLE: [
    "home",
    "workout",
    "challenge",
    "mealPlan",
    "nutrition_tracker",
    "meal_analysis",
    "profile",
    "workoutplan",
    "longevity",
    "application",
    "community",
    "coach_victor",
    "longevity_plan",
  ],
};

export const normalizedTier = (value: unknown): string => {
  const tier = String(value ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(" ", "_");
  return Object.hasOwn(subscriptionAccess, tier) ? tier : "NONE";
};

export const sessionVersion = (user: Document): number => {
  const parsed = Number(user.auth_session_version ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
};

export const userHasFeature = (user: Document, feature: string): boolean => {
  if (user.is_admin) return true;
  const tier = normalizedTier(
    user.subscription_tier ?? user.subscription_role ?? user.tier,
  );
  return subscriptionAccess[tier]?.includes(feature) ?? false;
};

async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(import("@fastify/jwt"), {
    secret: config.jwtSecretKey,
    sign: { algorithm: config.jwtAlgorithm as "HS256" },
  });

  app.decorate(
    "authenticate",
    async (request: FastifyRequest): Promise<AuthUser> => {
      if (request.currentUser) return request.currentUser;
      const headerToken = request.headers.authorization
        ?.replace(/^Bearer\s+/i, "")
        .trim();
      const token = headerToken || request.cookies.access_token;
      if (!token) return unauthorized("Missing access token");

      let payload: { sub?: string; type?: string; ver?: number };
      try {
        payload = app.jwt.verify(token);
      } catch {
        return unauthorized("Invalid access token");
      }
      if (
        payload.type !== "access" ||
        !payload.sub ||
        !ObjectId.isValid(payload.sub)
      ) {
        unauthorized("Invalid access token");
      }
      const user = (await app.mongo.collection("users").findOne({
        _id: new ObjectId(payload.sub),
        is_verified: true,
      })) as AuthUser | null;
      if (!user) return unauthorized("Invalid access token");
      if (Number(payload.ver ?? 0) !== sessionVersion(user)) {
        unauthorized("Session expired");
      }
      request.currentUser = user;
      return user;
    },
  );

  app.decorate(
    "requireAdmin",
    async (request: FastifyRequest): Promise<AuthUser> => {
      const user = await app.authenticate(request);
      if (!user.is_admin) forbidden("Admin access required");
      return user;
    },
  );

  app.decorate(
    "requireFeature",
    async (
      request: FastifyRequest,
      feature: string,
      detail: string,
    ): Promise<AuthUser> => {
      const user = await app.authenticate(request);
      if (!userHasFeature(user, feature)) forbidden(detail);
      return user;
    },
  );
}

export default fp(authPlugin, { name: "auth", dependencies: ["database"] });
