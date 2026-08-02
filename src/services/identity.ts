import {
  decodeProtectedHeader,
  importX509,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { FastifyInstance } from "fastify";
import type { Document } from "mongodb";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

const certificateCache = new Map<
  string,
  { expires: number; certificates: Record<string, string> }
>();

async function certificates(url: string): Promise<Record<string, string>> {
  const cached = certificateCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.certificates;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new AppError(500, "Unable to load remote identity payload");
  }
  const payload = (await response.json()) as Record<string, string>;
  certificateCache.set(url, {
    expires: Date.now() + 60 * 60 * 1000,
    certificates: payload,
  });
  return payload;
}

async function verifyX509Token(
  token: string,
  certUrl: string,
  audience: string,
  issuer: string | string[],
  detail: string,
): Promise<JWTPayload> {
  try {
    const header = decodeProtectedHeader(token);
    if (!header.kid) throw new Error("Missing key id");
    const certificate = (await certificates(certUrl))[header.kid];
    if (!certificate) throw new Error("Unknown key id");
    const key = await importX509(certificate, "RS256");
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["RS256"],
      audience,
      issuer,
    });
    return payload;
  } catch {
    throw new AppError(401, detail);
  }
}

export const verifyFirebaseToken = async (
  token: string,
): Promise<JWTPayload> => {
  if (!config.firebaseProjectId) {
    throw new AppError(500, "Firebase auth is not configured");
  }
  return verifyX509Token(
    token,
    config.firebaseCertUrl,
    config.firebaseProjectId,
    `https://securetoken.google.com/${config.firebaseProjectId}`,
    "Invalid Firebase token",
  );
};

export const verifyGoogleIdToken = async (
  token: string,
): Promise<JWTPayload> => {
  if (!config.googleClientId) {
    throw new AppError(500, "Google auth is not configured");
  }
  return verifyX509Token(
    token,
    config.googleCertUrl,
    config.googleClientId,
    ["https://accounts.google.com", "accounts.google.com"],
    "Invalid Google token",
  );
};

export async function googleAccessTokenProfile(
  token: string,
): Promise<JWTPayload> {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new AppError(401, "Invalid Google token");
  return (await response.json()) as JWTPayload;
}

export async function upsertIdentityUser(
  app: FastifyInstance,
  profile: JWTPayload,
  provider: "firebase" | "google",
): Promise<Document> {
  const email = String(profile.email ?? "")
    .trim()
    .toLowerCase();
  if (!email) {
    throw new AppError(
      400,
      "Identity provider did not return an email address",
    );
  }
  if (profile.email_verified === false) {
    throw new AppError(403, "Email is not verified");
  }
  const now = new Date();
  const name = String(
    profile.name ?? profile.given_name ?? email.split("@")[0] ?? "",
  ).trim();
  const providerId = String(profile.sub ?? "").trim();
  await app.mongo.collection("users").updateOne(
    { email },
    {
      $set: {
        email,
        name,
        is_verified: true,
        updated_at: now,
        profile_image: String(profile.picture ?? ""),
        [`${provider}_id`]: providerId,
        auth_provider: provider,
      },
      $setOnInsert: {
        created_at: now,
        role: "user",
        is_admin: false,
        subscription_tier: "NONE",
        subscription_role: "NONE",
        subscription_status: "NONE",
        subscription_billing_cycle: "yearly",
        subscription_is_purchased: false,
        subscription_purchase_source: "",
        onboarding_completed: false,
        auth_session_version: 0,
      },
    },
    { upsert: true },
  );
  return (await app.mongo.collection("users").findOne({ email }))!;
}
