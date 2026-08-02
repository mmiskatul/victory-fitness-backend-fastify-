import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { storeHealthMetrics } from "./health.js";
import { backfillCurrentHealthMetrics } from "./health.js";
import {
  decryptWearableToken,
  encryptWearableToken,
} from "./wearable-tokens.js";

type Provider = "fitbit" | "google-fit" | "garmin";

const remoteProviders = new Set<Provider>(["fitbit", "google-fit", "garmin"]);
const dateKey = (value: Date): string => value.toISOString().slice(0, 10);
const dayBounds = (day: string) => ({
  start_time: `${day}T00:00:00.000Z`,
  end_time: `${day}T23:59:59.999Z`,
});
const numeric = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function responseJson(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new AppError(
      502,
      `${label} request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as Record<string, any>;
}

const providerOAuth = (provider: Provider) => {
  if (provider === "fitbit") {
    return {
      tokenUrl: config.fitbit.tokenUrl,
      clientId: config.fitbit.clientId,
      clientSecret: config.fitbit.clientSecret,
    };
  }
  if (provider === "google-fit") {
    return {
      tokenUrl: config.googleFit.tokenUri,
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
    };
  }
  return {
    tokenUrl: config.garmin.tokenUrl,
    clientId: config.garmin.clientId,
    clientSecret: config.garmin.clientSecret,
  };
};

async function activeAccessToken(
  app: FastifyInstance,
  userId: string,
  provider: Provider,
): Promise<string> {
  const tokens = app.mongo.collection("provider_tokens");
  const token = await tokens.findOne({ user_id: userId, provider });
  if (!token?.access_token) {
    throw new AppError(404, `${provider} is not connected for this user`);
  }
  const expiresAt = token.expires_at
    ? new Date(token.expires_at).getTime()
    : Infinity;
  if (expiresAt > Date.now() + 60_000) {
    return decryptWearableToken(String(token.access_token));
  }
  const refreshToken = decryptWearableToken(String(token.refresh_token ?? ""));
  if (!refreshToken) return decryptWearableToken(String(token.access_token));
  const oauth = providerOAuth(provider);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (provider === "fitbit") {
    headers.authorization = `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", oauth.clientId);
    body.set("client_secret", oauth.clientSecret);
  }
  const refreshed = await responseJson(
    oauth.tokenUrl,
    { method: "POST", headers, body },
    `${provider} token refresh`,
  );
  if (!refreshed.access_token) {
    throw new AppError(
      502,
      `${provider} token refresh returned no access token`,
    );
  }
  const now = new Date();
  await tokens.updateOne(
    { _id: token._id },
    {
      $set: {
        access_token: encryptWearableToken(String(refreshed.access_token)),
        refresh_token: refreshed.refresh_token
          ? encryptWearableToken(String(refreshed.refresh_token))
          : token.refresh_token,
        expires_at: refreshed.expires_in
          ? new Date(Date.now() + Number(refreshed.expires_in) * 1000)
          : (token.expires_at ?? null),
        updated_at: now,
      },
    },
  );
  return String(refreshed.access_token);
}

const dailyMetric = (
  metric_type: string,
  value: unknown,
  unit: string,
  day: string,
  source: string,
  externalId: string,
) => {
  const parsed = numeric(value);
  if (parsed === null) return null;
  return {
    metric_type,
    value: metric_type === "steps" ? Math.round(parsed) : parsed,
    unit,
    ...dayBounds(day),
    source_device: source,
    external_id: externalId,
    metadata: { external_id: externalId },
  };
};

async function syncFitbit(
  app: FastifyInstance,
  userId: string,
  start: string,
  end: string,
) {
  const accessToken = await activeAccessToken(app, userId, "fitbit");
  const headers = { authorization: `Bearer ${accessToken}` };
  const metrics: Array<Record<string, any>> = [];
  for (const [type, path, unit, key] of [
    ["steps", "steps", "count", "activities-steps"],
    ["calories", "calories", "kcal", "activities-calories"],
    ["distance", "distance", "km", "activities-distance"],
  ] as const) {
    const payload = await responseJson(
      `${config.fitbit.apiBaseUrl}/1/user/-/activities/${path}/date/${start}/${end}.json`,
      { headers },
      "Fitbit",
    );
    for (const item of payload[key] ?? []) {
      const metric = dailyMetric(
        type,
        item.value,
        unit,
        String(item.dateTime),
        "Fitbit",
        `fitbit-${type}-${String(item.dateTime)}`,
      );
      if (metric) metrics.push(metric);
    }
  }
  for (
    let cursor = new Date(`${start}T00:00:00Z`);
    cursor <= new Date(`${end}T00:00:00Z`);
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const day = dateKey(cursor);
    const [heart, sleep] = await Promise.all([
      responseJson(
        `${config.fitbit.apiBaseUrl}/1/user/-/activities/heart/date/${day}/1d.json`,
        { headers },
        "Fitbit heart rate",
      ),
      responseJson(
        `${config.fitbit.apiBaseUrl}/1.2/user/-/sleep/date/${day}.json`,
        { headers },
        "Fitbit sleep",
      ),
    ]);
    for (const item of heart["activities-heart"] ?? []) {
      const metric = dailyMetric(
        "heart_rate",
        item.value?.restingHeartRate,
        "bpm",
        String(item.dateTime ?? day),
        "Fitbit",
        `fitbit-heart_rate-${String(item.dateTime ?? day)}`,
      );
      if (metric) metrics.push(metric);
    }
    for (const item of sleep.sleep ?? []) {
      const minutes = numeric(item.minutesAsleep);
      if (minutes === null || !item.startTime || !item.endTime) continue;
      metrics.push({
        metric_type: "sleep",
        value: Math.round((minutes / 60) * 100) / 100,
        unit: "hours",
        start_time: item.startTime,
        end_time: item.endTime,
        source_device: "Fitbit",
        external_id: `fitbit-sleep-${String(item.logId ?? day)}`,
        metadata: {
          external_id: `fitbit-sleep-${String(item.logId ?? day)}`,
          minutes_asleep: minutes,
          minutes_awake: numeric(item.minutesAwake) ?? 0,
          efficiency: numeric(item.efficiency) ?? 0,
        },
      });
    }
  }
  return storeHealthMetrics(app, userId, "fitbit", metrics, "Fitbit");
}

async function syncGoogleFit(
  app: FastifyInstance,
  userId: string,
  start: string,
  end: string,
) {
  const accessToken = await activeAccessToken(app, userId, "google-fit");
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${end}T23:59:59.999Z`).getTime();
  const specs = [
    ["com.google.step_count.delta", "steps", "count"],
    ["com.google.distance.delta", "distance", "m"],
    ["com.google.calories.expended", "calories", "kcal"],
    ["com.google.heart_rate.bpm", "heart_rate", "bpm"],
  ] as const;
  const payload = await responseJson(
    `${config.googleFit.apiBaseUrl}/users/me/dataset:aggregate`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        startTimeMillis: startMs,
        endTimeMillis: endMs,
        aggregateBy: specs.map(([dataTypeName]) => ({ dataTypeName })),
        bucketByTime: { durationMillis: 86_400_000 },
      }),
    },
    "Google Fit",
  );
  const metrics: Array<Record<string, any>> = [];
  for (const bucket of payload.bucket ?? []) {
    const bucketStart = new Date(Number(bucket.startTimeMillis ?? startMs));
    const bucketEnd = new Date(Number(bucket.endTimeMillis ?? endMs));
    for (const [index, dataset] of (bucket.dataset ?? []).entries()) {
      const spec = specs[index];
      if (!spec) continue;
      let total = 0;
      for (const point of dataset.point ?? []) {
        for (const value of point.value ?? []) {
          total += Number(value.intVal ?? value.fpVal ?? 0);
        }
      }
      if (total <= 0) continue;
      metrics.push({
        metric_type: spec[1],
        value: spec[1] === "steps" ? Math.round(total) : total,
        unit: spec[2],
        start_time: bucketStart,
        end_time: bucketEnd,
        source_device: "Google Fit",
        external_id: `google-fit-${spec[1]}-${dateKey(bucketStart)}`,
        metadata: {
          external_id: `google-fit-${spec[1]}-${dateKey(bucketStart)}`,
        },
      });
    }
  }
  return storeHealthMetrics(app, userId, "google-fit", metrics, "Google Fit");
}

async function syncGarmin(
  app: FastifyInstance,
  userId: string,
  start: string,
  end: string,
) {
  const accessToken = await activeAccessToken(app, userId, "garmin");
  const query = new URLSearchParams({
    uploadStartTimeInSeconds: String(
      Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000),
    ),
    uploadEndTimeInSeconds: String(
      Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1000),
    ),
  });
  const payload = await responseJson(
    `${config.garmin.apiBaseUrl}${config.garmin.dailySummaryPath}?${query}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    "Garmin",
  );
  const summaries =
    payload.dailies ?? payload.dailySummaries ?? payload.items ?? [];
  const metrics: Array<Record<string, any>> = [];
  for (const summary of summaries) {
    const day = String(summary.calendarDate ?? summary.date ?? "");
    if (!day) continue;
    for (const [type, value, unit] of [
      ["steps", summary.steps, "count"],
      ["calories", summary.activeKilocalories ?? summary.calories, "kcal"],
      ["distance", summary.distanceInMeters, "m"],
      ["stress", summary.averageStressLevel, "score"],
      [
        "body_battery",
        summary.bodyBatteryChargedValue ?? summary.bodyBattery,
        "score",
      ],
      ["spo2", summary.avgSpo2Value, "%"],
    ] as const) {
      const metric = dailyMetric(
        type,
        value,
        unit,
        day,
        "Garmin",
        `garmin-${type}-${day}`,
      );
      if (metric) metrics.push(metric);
    }
  }
  return storeHealthMetrics(app, userId, "garmin", metrics, "Garmin");
}

export async function syncRemoteProvider(
  app: FastifyInstance,
  userId: string,
  provider: string,
  startDate?: string,
  endDate?: string,
) {
  if (!remoteProviders.has(provider as Provider)) {
    throw new AppError(400, "Unsupported remote wearable provider");
  }
  const connection = await app.mongo
    .collection("user_provider_connections")
    .findOne({
      user_id: userId,
      provider,
      status: "connected",
    });
  if (!connection) {
    throw new AppError(404, `${provider} is not connected for this user`);
  }
  const end = endDate || dateKey(new Date());
  const start =
    startDate ||
    dateKey(
      new Date(
        Date.now() -
          Math.max(config.wearableSchedulerLookbackDays - 1, 0) * 86_400_000,
      ),
    );
  const result =
    provider === "fitbit"
      ? await syncFitbit(app, userId, start, end)
      : provider === "google-fit"
        ? await syncGoogleFit(app, userId, start, end)
        : await syncGarmin(app, userId, start, end);
  const now = new Date();
  await app.mongo.collection("user_provider_connections").updateOne(
    { _id: connection._id },
    {
      $set: {
        last_synced_at: now,
        last_sync_status: "success",
        last_sync_message: `${provider} sync completed with ${result.inserted} records.`,
        updated_at: now,
      },
    },
  );
  return result;
}

export async function processIntegrationJobs(
  app: FastifyInstance,
  limit = config.syncQueueConcurrency,
): Promise<{ processed: number; failed: number }> {
  const jobs = app.mongo.collection("sync_jobs");
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < Math.max(limit, 1); index += 1) {
    const now = new Date();
    const job = await jobs.findOneAndUpdate(
      {
        status: "queued",
        $or: [
          { next_attempt_at: { $exists: false } },
          { next_attempt_at: null },
          { next_attempt_at: { $lte: now } },
        ],
      },
      {
        $set: { status: "processing", started_at: now, updated_at: now },
        $inc: { attempts: 1 },
      },
      { sort: { created_at: 1 }, returnDocument: "after" },
    );
    if (!job) break;
    try {
      const provider = String(job.provider ?? "");
      const userId = String(job.user_id ?? "");
      const importJob =
        job.job_type === "import-provider-data" || Array.isArray(job.metrics);
      const result = importJob
        ? await storeHealthMetrics(
            app,
            userId,
            provider || "qr-import",
            job.metrics ?? [],
            String(job.source_device ?? ""),
          )
        : await syncRemoteProvider(
            app,
            userId,
            provider,
            job.start_date ? String(job.start_date) : undefined,
            job.end_date ? String(job.end_date) : undefined,
          );
      const completedAt = new Date();
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "success",
            synced_records: result.inserted,
            skipped_duplicates: result.skipped,
            completed_at: completedAt,
            updated_at: completedAt,
          },
          $unset: { next_attempt_at: "", error: "" },
        },
      );
      processed += 1;
    } catch (error) {
      const attempts = Number(job.attempts ?? 1);
      const retry = attempts < Math.max(config.syncRetryAttempts, 1);
      const failedAt = new Date();
      const detail = error instanceof Error ? error.message : String(error);
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: retry ? "queued" : "failed",
            error: detail,
            next_attempt_at: retry
              ? new Date(Date.now() + config.syncRetryBackoffMs * attempts)
              : null,
            ...(retry ? {} : { completed_at: failedAt }),
            updated_at: failedAt,
          },
        },
      );
      await app.mongo.collection("integration_audit_logs").insertOne({
        user_id: String(job.user_id ?? ""),
        provider: String(job.provider ?? ""),
        action: String(job.job_type ?? "sync-provider-data"),
        status: retry ? "retrying" : "failed",
        detail,
        job_id: String(job._id),
        created_at: failedAt,
      });
      failed += 1;
    }
  }
  return { processed, failed };
}

export async function enqueueScheduledWearableSyncs(app: FastifyInstance) {
  if (!config.wearableSchedulerEnabled) return 0;
  const connections = await app.mongo
    .collection("user_provider_connections")
    .find({ provider: { $in: [...remoteProviders] }, status: "connected" })
    .toArray();
  let queued = 0;
  for (const connection of connections) {
    const filter = {
      user_id: String(connection.user_id),
      provider: String(connection.provider),
      status: { $in: ["queued", "processing"] },
    };
    if (await app.mongo.collection("sync_jobs").findOne(filter)) continue;
    const now = new Date();
    await app.mongo.collection("sync_jobs").insertOne({
      user_id: String(connection.user_id),
      provider: String(connection.provider),
      job_type: "sync-provider-data",
      trigger: "scheduled_sync",
      status: "queued",
      attempts: 0,
      created_at: now,
      updated_at: now,
    });
    queued += 1;
  }
  return queued;
}

export function startWearableWorkers(app: FastifyInstance): void {
  if (!app.mongo.configured || !config.startupJobsEnabled) return;
  void backfillCurrentHealthMetrics(app).catch((error) =>
    app.log.error({ error }, "wearable health backfill failed"),
  );
  let processing = false;
  const process = async () => {
    if (processing) return;
    processing = true;
    try {
      await processIntegrationJobs(app);
    } catch (error) {
      app.log.error({ err: error }, "integration job worker failed");
    } finally {
      processing = false;
    }
  };
  const queueTimer = setInterval(() => void process(), 1_000);
  queueTimer.unref();
  void process();

  let scheduling = false;
  const schedule = async () => {
    if (scheduling || !config.wearableSchedulerEnabled) return;
    scheduling = true;
    try {
      await enqueueScheduledWearableSyncs(app);
      await process();
    } catch (error) {
      app.log.error({ err: error }, "scheduled wearable sync failed");
    } finally {
      scheduling = false;
    }
  };
  const schedulerTimer = setInterval(
    () => void schedule(),
    Math.max(config.wearableSchedulerIntervalMinutes, 1) * 60_000,
  );
  schedulerTimer.unref();
  if (config.wearableSchedulerEnabled) void schedule();
  app.addHook("onClose", async () => {
    clearInterval(queueTimer);
    clearInterval(schedulerTimer);
  });
}
