import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { AppError } from "../lib/errors.js";

const supportedMetricTypes = new Set([
  "steps",
  "heart_rate",
  "sleep",
  "calories",
  "workouts",
  "workout",
  "hrv",
  "spo2",
  "stress",
  "body_battery",
  "distance",
]);

const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "Each metric requires start_time and end_time");
  }
  return date.toISOString().replace(/Z$/, "+00:00");
};

const pythonJson = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${pythonJson(object[key])}`)
    .join(", ")}}`;
};

const recordKey = (record: Record<string, any>): string =>
  String(
    record.dedupe_key ??
      record.current_key ??
      record.external_id ??
      record._id ??
      record.id ??
      "",
  );

const sortTime = (record: Record<string, any>): number => {
  for (const field of [
    "synced_at",
    "end_time",
    "start_time",
    "created_at",
    "updated_at",
  ]) {
    const parsed = new Date(record[field] ?? "").getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

export function normalizeHealthMetric(
  userId: string,
  provider: string,
  metric: Record<string, any>,
  fallbackSourceDevice = "",
): Record<string, any> {
  let metricType = String(metric.metric_type ?? "")
    .trim()
    .toLowerCase();
  if (!supportedMetricTypes.has(metricType)) {
    throw new AppError(400, `Unsupported metric_type: ${metricType}`);
  }
  if (metricType === "workout") metricType = "workouts";
  const startTime = iso(metric.start_time);
  const endTime = iso(metric.end_time);
  const metadata =
    metric.metadata && typeof metric.metadata === "object"
      ? { ...metric.metadata }
      : {};
  const externalId = String(
    metric.external_id ?? metadata.external_id ?? "",
  ).trim();
  const sourceDevice = String(
    metric.source_device ?? fallbackSourceDevice ?? "",
  );
  const now = new Date();
  const document: Record<string, any> = {
    _id: new ObjectId(),
    user_id: userId,
    provider,
    external_id: externalId,
    type: metricType === "workouts" ? "workout" : metricType,
    metric_type: metricType,
    value: metric.value,
    unit: String(metric.unit ?? ""),
    started_at: new Date(startTime),
    ended_at: new Date(endTime),
    start_time: new Date(startTime),
    end_time: new Date(endTime),
    source_device: sourceDevice,
    metadata,
    created_at: now,
    synced_at: now,
  };
  const dedupePayload = {
    user_id: userId,
    provider,
    metric_type: metricType,
    value: metric.value,
    unit: document.unit,
    start_time: startTime,
    end_time: endTime,
    source_device: sourceDevice,
    external_id: externalId,
  };
  document.dedupe_key = createHash("sha256")
    .update(pythonJson(dedupePayload))
    .digest("hex");
  document.day = endTime.slice(0, 10);
  document.current_key = [
    userId.trim(),
    provider.trim().toLowerCase(),
    metricType,
    document.day,
    sourceDevice.trim().toLowerCase(),
  ].join("|");
  return document;
}

async function replaceSnapshot(
  app: FastifyInstance,
  collectionName: "health_samples" | "health_metric_current",
  userId: string,
  incoming: Array<Record<string, any>>,
): Promise<number> {
  const collection = app.mongo.collection(collectionName);
  const existingDocuments = await collection
    .find({ user_id: userId })
    .toArray();
  const existingSnapshot = existingDocuments[0] ?? {};
  const existing = existingDocuments.flatMap((document) =>
    Array.isArray(document.records) ? document.records : [document],
  );
  const existingKeys = new Set(existing.map(recordKey).filter(Boolean));
  const incomingKeys = new Set<string>();
  let inserted = 0;
  for (const record of incoming) {
    const key = recordKey(record);
    if (!existingKeys.has(key) && !incomingKeys.has(key)) inserted += 1;
    if (key) incomingKeys.add(key);
  }
  const merged = new Map<string, Record<string, any>>();
  for (const record of [...existing, ...incoming]) {
    const key = recordKey(record) || new ObjectId().toHexString();
    const current = merged.get(key);
    if (!current || sortTime(record) >= sortTime(current)) {
      merged.set(key, record);
    }
  }
  const records = [...merged.values()].sort(
    (a, b) => sortTime(b) - sortTime(a),
  );
  const now = new Date();
  const snapshot: Record<string, any> = {
    _id: existingSnapshot._id ?? new ObjectId(),
    user_id: userId,
    records,
    record_count: records.length,
    latest_synced_at: records[0]?.synced_at ?? null,
    latest_end_time: records[0]?.end_time ?? null,
    created_at: existingSnapshot.created_at ?? now,
    updated_at: now,
  };
  if (records.length) {
    snapshot.provider = records[0]!.provider ?? "";
    snapshot.metric_type = records[0]!.metric_type ?? "";
    snapshot.source_device = records[0]!.source_device ?? "";
  }
  await collection.replaceOne({ user_id: userId }, snapshot, { upsert: true });
  await collection.deleteMany({ user_id: userId, _id: { $ne: snapshot._id } });
  return inserted;
}

export async function storeHealthMetrics(
  app: FastifyInstance,
  userId: string,
  provider: string,
  metrics: Array<Record<string, any>>,
  sourceDevice = "",
): Promise<{ inserted: number; skipped: number; records: any[] }> {
  const records = metrics.map((metric) =>
    normalizeHealthMetric(userId, provider, metric, sourceDevice),
  );
  if (!records.length) return { inserted: 0, skipped: 0, records: [] };
  await replaceSnapshot(app, "health_samples", userId, records);
  const inserted = await replaceSnapshot(
    app,
    "health_metric_current",
    userId,
    records,
  );
  return { inserted, skipped: Math.max(records.length - inserted, 0), records };
}

export async function backfillCurrentHealthMetrics(
  app: FastifyInstance,
  force = false,
): Promise<number> {
  const current = app.mongo.collection("health_metric_current");
  if (force) await current.deleteMany({});
  else if ((await current.countDocuments({})) > 0) return 0;
  const samples = await app.mongo
    .collection("health_samples")
    .find({})
    .toArray();
  let processed = 0;
  for (const sample of samples) {
    const userId = String(sample.user_id ?? "");
    if (!userId) continue;
    const existing = await current.findOne({ user_id: userId });
    await current.replaceOne(
      { user_id: userId },
      {
        ...sample,
        _id: existing?._id ?? new ObjectId(),
        user_id: userId,
        updated_at: new Date(),
      },
      { upsert: true },
    );
    processed += 1;
  }
  return processed;
}
