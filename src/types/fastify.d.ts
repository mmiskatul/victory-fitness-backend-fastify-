import type { Collection, Db, MongoClient } from "mongodb";
import type { AuthUser } from "../plugins/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    mongo: {
      client: MongoClient | null;
      db: Db | null;
      collection: (name: string) => Collection<any>;
      configured: boolean;
    };
    authenticate: (request: FastifyRequest) => Promise<AuthUser>;
    requireAdmin: (request: FastifyRequest) => Promise<AuthUser>;
    requireFeature: (
      request: FastifyRequest,
      feature: string,
      detail: string,
    ) => Promise<AuthUser>;
  }

  interface FastifyRequest {
    currentUser?: AuthUser;
    requestStartedAt?: number;
    rawBody?: Buffer;
  }
}

export {};
