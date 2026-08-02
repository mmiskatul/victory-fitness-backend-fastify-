import type { FastifyInstance } from "fastify";
import type { Document } from "mongodb";
import { importPKCS8, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

type PushData = Record<string, unknown>;
let firebaseToken: { value: string; expiresAt: number } | null = null;

async function firebaseAccessToken(): Promise<string> {
  if (firebaseToken && firebaseToken.expiresAt > Date.now() + 60_000) {
    return firebaseToken.value;
  }
  if (
    !config.firebaseClientEmail ||
    !config.firebasePrivateKey ||
    !config.firebaseProjectId
  ) {
    throw new Error(
      "Firebase web push service-account credentials are not configured",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(config.firebasePrivateKey, "RS256");
  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.firebaseClientEmail)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Firebase token exchange failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    access_token: string;
    expires_in?: number;
  };
  firebaseToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return payload.access_token;
}

async function sendExpo(
  tokens: string[],
  title: string,
  body: string,
  data: PushData,
): Promise<void> {
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(
      tokens.map((to) => ({ to, sound: "default", title, body, data })),
    ),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Expo push failed (${response.status})`);
}

async function sendFirebase(
  tokens: string[],
  title: string,
  body: string,
  data: PushData,
): Promise<void> {
  const accessToken = await firebaseAccessToken();
  const endpoint = `https://fcm.googleapis.com/v1/projects/${config.firebaseProjectId}/messages:send`;
  const results = await Promise.allSettled(
    tokens.map((token) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: Object.fromEntries(
              Object.entries(data).map(([key, value]) => [key, String(value)]),
            ),
            webpush: { fcm_options: { link: "/notifications" } },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`Firebase push failed (${response.status})`);
        }
      }),
    ),
  );
  if (results.every((result) => result.status === "rejected")) {
    throw new Error("Firebase push failed for all tokens");
  }
}

export async function notifyUser(
  app: FastifyInstance,
  user: Document,
  title: string,
  message: string,
  type: string,
  data: PushData,
) {
  const id = randomUUID();
  const createdAt = new Date();
  const notificationData = { ...data, notificationId: id };
  const notification = {
    id,
    type,
    title,
    message,
    data: notificationData,
    created_at: createdAt,
    read: false,
    delivery: { status: "queued", providers: [] as string[] },
  };
  const users = app.mongo.collection("users");
  await users.updateOne({ _id: user._id }, {
    $push: { app_notifications: { $each: [notification], $slice: -50 } },
  } as any);
  const tokens = (
    Array.isArray(user.push_tokens) ? user.push_tokens : []
  ).filter((item: any) => item?.token);
  const expo = [
    ...new Set(
      tokens
        .filter(
          (item: any) =>
            item.platform !== "web" &&
            String(item.token).startsWith("ExponentPushToken["),
        )
        .map((item: any) => String(item.token)),
    ),
  ] as string[];
  const web = [
    ...new Set(
      tokens
        .filter((item: any) => item.platform === "web")
        .map((item: any) => String(item.token)),
    ),
  ] as string[];
  const jobs: Array<{ provider: string; promise: Promise<void> }> = [];
  if (expo.length) {
    jobs.push({
      provider: "expo",
      promise: sendExpo(expo, title, message, notificationData),
    });
  }
  if (web.length) {
    jobs.push({
      provider: "firebase",
      promise: sendFirebase(web, title, message, notificationData),
    });
  }
  const settled = await Promise.allSettled(jobs.map((job) => job.promise));
  const failedProviders = settled.flatMap((result, index) =>
    result.status === "rejected" ? [jobs[index]!.provider] : [],
  );
  const status = !jobs.length
    ? "inbox_only"
    : failedProviders.length === jobs.length
      ? "failed"
      : failedProviders.length
        ? "partial"
        : "sent";
  const delivery = {
    status,
    providers: jobs.map((job) => job.provider),
    failedProviders,
    updatedAt: new Date(),
  };
  await users.updateOne(
    { _id: user._id, "app_notifications.id": id },
    { $set: { "app_notifications.$.delivery": delivery } },
  );
  return delivery;
}
