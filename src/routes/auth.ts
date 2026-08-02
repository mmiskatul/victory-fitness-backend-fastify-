import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { ObjectId, type Document } from "mongodb";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { sessionVersion } from "../plugins/auth.js";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../services/email.js";
import {
  googleAccessTokenProfile,
  upsertIdentityUser,
  verifyFirebaseToken,
  verifyGoogleIdToken,
} from "../services/identity.js";
import { serializeMe } from "../services/users.js";

const email = Type.String({ minLength: 3, maxLength: 320 });
const registerSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  surname: Type.String({ minLength: 1, maxLength: 80 }),
  email,
  mobile: Type.String({ minLength: 3, maxLength: 30 }),
  password: Type.String({ minLength: 8, maxLength: 128 }),
  marketing_consent: Type.Optional(Type.Boolean({ default: false })),
  signup_source: Type.Optional(
    Type.String({ maxLength: 120, default: "organic" }),
  ),
});
const emailSchema = Type.Object({ email });
const codeSchema = Type.Object({
  email,
  code: Type.String({ pattern: "^\\d{4}$" }),
});
const resetSchema = Type.Object({
  reset_token: Type.String({ minLength: 20 }),
  new_password: Type.String({ minLength: 8, maxLength: 128 }),
});
const loginSchema = Type.Object({
  email,
  password: Type.String({ minLength: 1, maxLength: 128 }),
});
const identitySchema = Type.Object({
  id_token: Type.Optional(Type.String({ minLength: 20 })),
  access_token: Type.Optional(Type.String({ minLength: 20 })),
});
const optionalSessionSchema = Type.Object({
  session_token: Type.Optional(Type.String()),
});

const verificationCode = (): string =>
  randomInt(0, 10_000).toString().padStart(4, "0");
const expires = (minutes: number): Date =>
  new Date(Date.now() + minutes * 60_000);
const normalizeEmail = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();
const appClient = (request: FastifyRequest): boolean =>
  String(request.headers["x-victory-client"] ?? "")
    .trim()
    .toLowerCase() === "app";

async function issueTokens(
  app: FastifyInstance,
  reply: FastifyReply,
  user: Document,
  issueCookies = true,
) {
  const version = sessionVersion(user);
  const subject = String(user._id);
  const accessToken = app.jwt.sign(
    { sub: subject, type: "access", ver: version },
    { expiresIn: config.accessTokenExpireMinutes * 60 },
  );
  const sessionToken = app.jwt.sign(
    { sub: subject, type: "session", ver: version },
    { expiresIn: config.sessionTokenExpireDays * 86_400 },
  );
  if (issueCookies) {
    const common = {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      path: "/",
    } as const;
    reply.setCookie("access_token", accessToken, {
      ...common,
      maxAge: config.accessTokenExpireMinutes * 60,
    });
    reply.setCookie("session_token", sessionToken, {
      ...common,
      maxAge: config.sessionTokenExpireDays * 86_400,
    });
  }
  const profile = await serializeMe(app, user);
  return {
    access_token: accessToken,
    session_token: sessionToken,
    token_type: "bearer",
    expires_in: config.accessTokenExpireMinutes * 60,
    user: profile,
    returning_user: null,
  };
}

function verifiedSession(
  app: FastifyInstance,
  token: string,
  expectedType: "session" | "password_reset",
): { sub: string; type: string; ver?: number } {
  try {
    const payload = app.jwt.verify<{ sub: string; type: string; ver?: number }>(
      token,
    );
    if (payload.type !== expectedType || !ObjectId.isValid(payload.sub)) {
      throw new Error("Invalid token");
    }
    return payload;
  } catch {
    throw new AppError(
      401,
      expectedType === "session"
        ? "Invalid session token"
        : "Invalid reset token",
    );
  }
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/auth/register",
    { schema: { body: registerSchema } },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        surname: string;
        email: string;
        mobile: string;
        password: string;
        marketing_consent?: boolean;
        signup_source?: string;
      };
      const normalized = normalizeEmail(body.email);
      const users = app.mongo.collection("users");
      const existing = await users.findOne({ email: normalized });
      if (existing?.is_verified) {
        throw new AppError(409, "Email is already registered");
      }
      const code = verificationCode();
      const now = new Date();
      const firstName = body.name.trim();
      const lastName = body.surname.trim();
      await users.updateOne(
        { email: normalized },
        {
          $set: {
            name: `${firstName} ${lastName}`.trim(),
            first_name: firstName,
            last_name: lastName,
            email: normalized,
            contact_number: body.mobile.trim(),
            marketing_consent: Boolean(body.marketing_consent),
            signup_source: body.signup_source?.trim() || "organic",
            marketing_consent_at: body.marketing_consent ? now : null,
            password_hash: await bcrypt.hash(body.password, 12),
            is_verified: false,
            role: "user",
            is_admin: false,
            subscription_tier: "NONE",
            subscription_role: "NONE",
            subscription_status: "NONE",
            subscription_billing_cycle: "yearly",
            subscription_is_purchased: false,
            subscription_purchase_source: "",
            onboarding_completed: false,
            verification_code_hash: await bcrypt.hash(code, 12),
            verification_code_expires_at: expires(10),
            updated_at: now,
          },
          $setOnInsert: { created_at: now, auth_session_version: 0 },
        },
        { upsert: true },
      );
      await sendVerificationEmail(normalized, code);
      return reply
        .code(202)
        .send({ message: "Verification code sent", email: normalized });
    },
  );

  app.post(
    "/auth/resend-verification",
    { schema: { body: emailSchema } },
    async (request, reply) => {
      const normalized = normalizeEmail(
        (request.body as { email: string }).email,
      );
      const users = app.mongo.collection("users");
      const user = await users.findOne({ email: normalized });
      if (!user) {
        throw new AppError(404, "No pending registration found for this email");
      }
      if (user.is_verified) {
        throw new AppError(409, "Email is already registered");
      }
      const code = verificationCode();
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            verification_code_hash: await bcrypt.hash(code, 12),
            verification_code_expires_at: expires(10),
            updated_at: new Date(),
          },
        },
      );
      await sendVerificationEmail(normalized, code);
      return reply
        .code(202)
        .send({ message: "Verification code sent", email: normalized });
    },
  );

  app.post(
    "/auth/verify-email",
    { schema: { body: codeSchema } },
    async (request, reply) => {
      const body = request.body as { email: string; code: string };
      const users = app.mongo.collection("users");
      const user = await users.findOne({ email: normalizeEmail(body.email) });
      if (!user) throw new AppError(404, "User not found");
      if (!user.is_verified) {
        if (
          !(user.verification_code_expires_at instanceof Date) ||
          user.verification_code_expires_at < new Date()
        ) {
          throw new AppError(400, "Verification code expired");
        }
        if (
          !user.verification_code_hash ||
          !(await bcrypt.compare(
            body.code,
            String(user.verification_code_hash),
          ))
        ) {
          throw new AppError(400, "Invalid verification code");
        }
        await users.updateOne(
          { _id: user._id },
          {
            $set: { is_verified: true, updated_at: new Date() },
            $unset: {
              verification_code_hash: "",
              verification_code_expires_at: "",
            },
          },
        );
        user.is_verified = true;
      }
      return issueTokens(app, reply, user);
    },
  );

  app.post(
    "/auth/forgot-password",
    { schema: { body: emailSchema } },
    async (request) => {
      const normalized = normalizeEmail(
        (request.body as { email: string }).email,
      );
      const users = app.mongo.collection("users");
      const user = await users.findOne({
        email: normalized,
        is_verified: true,
      });
      const result = {
        message: "If that account exists, a reset code has been sent",
        email: normalized,
      };
      if (!user) return result;
      const code = verificationCode();
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            reset_code_hash: await bcrypt.hash(code, 12),
            reset_code_expires_at: expires(10),
            updated_at: new Date(),
          },
        },
      );
      await sendPasswordResetEmail(normalized, code);
      return result;
    },
  );

  app.post(
    "/auth/verify-reset-code",
    { schema: { body: codeSchema } },
    async (request) => {
      const body = request.body as { email: string; code: string };
      const user = await app.mongo.collection("users").findOne({
        email: normalizeEmail(body.email),
        is_verified: true,
      });
      if (!user) throw new AppError(404, "User not found");
      if (
        !(user.reset_code_expires_at instanceof Date) ||
        user.reset_code_expires_at < new Date()
      ) {
        throw new AppError(400, "Reset code expired");
      }
      if (
        !user.reset_code_hash ||
        !(await bcrypt.compare(body.code, String(user.reset_code_hash)))
      ) {
        throw new AppError(400, "Invalid reset code");
      }
      const resetToken = app.jwt.sign(
        { sub: String(user._id), type: "password_reset" },
        { expiresIn: 15 * 60 },
      );
      await app.mongo.collection("users").updateOne(
        { _id: user._id },
        {
          $set: {
            password_reset_token_hash: await bcrypt.hash(resetToken, 12),
          },
        },
      );
      return { message: "Reset code verified", reset_token: resetToken };
    },
  );

  app.post(
    "/auth/reset-password",
    { schema: { body: resetSchema } },
    async (request) => {
      const body = request.body as {
        reset_token: string;
        new_password: string;
      };
      const payload = verifiedSession(app, body.reset_token, "password_reset");
      const users = app.mongo.collection("users");
      const user = await users.findOne({
        _id: new ObjectId(payload.sub),
        is_verified: true,
      });
      if (!user) throw new AppError(401, "Invalid reset token");
      if (
        !user.password_reset_token_hash ||
        !(await bcrypt.compare(
          body.reset_token,
          String(user.password_reset_token_hash),
        ))
      ) {
        throw new AppError(401, "Invalid or already used reset token");
      }
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            password_hash: await bcrypt.hash(body.new_password, 12),
            updated_at: new Date(),
          },
          $unset: {
            reset_code_hash: "",
            reset_code_expires_at: "",
            password_reset_token_hash: "",
          },
        },
      );
      return { message: "Password reset successful" };
    },
  );

  app.post(
    "/auth/login",
    { schema: { body: loginSchema } },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      const user = await app.mongo
        .collection("users")
        .findOne({ email: normalizeEmail(body.email) });
      if (
        !user?.password_hash ||
        !(await bcrypt.compare(body.password, String(user.password_hash)))
      ) {
        throw new AppError(401, "Invalid email or password");
      }
      if (!user.is_verified) throw new AppError(403, "Email is not verified");
      return issueTokens(app, reply, user, !appClient(request));
    },
  );

  app.post(
    "/auth/firebase",
    {
      schema: {
        body: Type.Object({ id_token: Type.String({ minLength: 20 }) }),
      },
    },
    async (request, reply) => {
      const profile = await verifyFirebaseToken(
        (request.body as { id_token: string }).id_token,
      );
      const user = await upsertIdentityUser(app, profile, "firebase");
      return issueTokens(app, reply, user);
    },
  );

  app.post(
    "/auth/google",
    { schema: { body: identitySchema } },
    async (request, reply) => {
      const body = request.body as { id_token?: string; access_token?: string };
      if (!body.id_token && !body.access_token) {
        throw new AppError(422, "id_token or access_token is required");
      }
      let profile;
      let provider: "firebase" | "google" = "google";
      if (body.id_token) {
        try {
          profile = await verifyGoogleIdToken(body.id_token);
        } catch (error) {
          if (!(error instanceof AppError) || error.statusCode !== 401) {
            throw error;
          }
          profile = await verifyFirebaseToken(body.id_token);
          provider = "firebase";
        }
      } else {
        profile = await googleAccessTokenProfile(body.access_token!);
      }
      const user = await upsertIdentityUser(app, profile, provider);
      return issueTokens(app, reply, user);
    },
  );

  app.post(
    "/auth/refresh",
    { schema: { body: Type.Optional(optionalSessionSchema) } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { session_token?: string };
      const token = body.session_token || request.cookies.session_token;
      if (!token) throw new AppError(401, "Missing session token");
      const payload = verifiedSession(app, token, "session");
      const user = await app.mongo.collection("users").findOne({
        _id: new ObjectId(payload.sub),
        is_verified: true,
      });
      if (!user) throw new AppError(401, "Invalid session token");
      if (Number(payload.ver ?? 0) !== sessionVersion(user)) {
        throw new AppError(401, "Session expired");
      }
      return issueTokens(app, reply, user, !appClient(request));
    },
  );

  app.post(
    "/auth/logout",
    { schema: { body: Type.Optional(optionalSessionSchema) } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { session_token?: string };
      const access = request.headers.authorization
        ?.replace(/^Bearer\s+/i, "")
        .trim();
      const token =
        access || body.session_token || request.cookies.session_token;
      if (token) {
        try {
          const payload = app.jwt.verify<{
            sub: string;
            type: string;
            ver?: number;
          }>(token);
          if (ObjectId.isValid(payload.sub)) {
            const user = await app.mongo.collection("users").findOne({
              _id: new ObjectId(payload.sub),
              is_verified: true,
            });
            if (user && Number(payload.ver ?? 0) === sessionVersion(user)) {
              await app.mongo
                .collection("users")
                .updateOne(
                  { _id: user._id },
                  { $set: { auth_session_version: sessionVersion(user) + 1 } },
                );
            }
          }
        } catch {
          // Logout remains idempotent for expired or malformed tokens.
        }
      }
      if (!appClient(request)) {
        const options = {
          path: "/",
          secure: config.cookieSecure,
          sameSite: config.cookieSameSite,
        };
        reply.clearCookie("access_token", options);
        reply.clearCookie("session_token", options);
      }
      return { message: "Logged out" };
    },
  );

  app.get("/auth/validate", async (request) => {
    await app.authenticate(request);
    return { status: "ok" };
  });
}
