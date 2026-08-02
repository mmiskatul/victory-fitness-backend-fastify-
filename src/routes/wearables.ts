import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { ObjectId } from "mongodb";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError } from "../lib/errors.js";
import { config } from "../config.js";
import { serialize } from "../lib/serialize.js";
import {
  backfillCurrentHealthMetrics,
  storeHealthMetrics,
} from "../services/health.js";
import { encryptWearableToken } from "../services/wearable-tokens.js";
import { syncRemoteProvider } from "../services/wearable-sync.js";

const flexible = Type.Object({}, { additionalProperties: true });
const providers = [
  "fitbit",
  "google-fit",
  "garmin",
  "apple-health",
  "health-connect",
  "this-phone",
  "qr-import",
];
const providerSchema = Type.Union(
  providers.map((provider) => Type.Literal(provider)),
);
const metricTypeSchema = Type.Union(
  [
    "steps",
    "heart_rate",
    "sleep",
    "calories",
    "workouts",
    "hrv",
    "spo2",
    "stress",
    "body_battery",
    "distance",
  ].map((metric) => Type.Literal(metric)),
);
const healthMetricSchema = Type.Object({
  metric_type: metricTypeSchema,
  value: Type.Union([Type.Integer(), Type.Number(), Type.String()]),
  unit: Type.Optional(Type.String()),
  start_time: Type.String(),
  end_time: Type.String(),
  source_device: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
});
const nativeSyncSchema = Type.Object({
  metrics: Type.Optional(Type.Array(healthMetricSchema)),
  source_device: Type.Optional(Type.String()),
  batch_id: Type.Optional(Type.String()),
});
const nativeSamplesSchema = Type.Object({
  provider: Type.String(),
  metrics: Type.Optional(
    Type.Array(Type.Object({}, { additionalProperties: true })),
  ),
  source_device: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String()),
  batch_id: Type.Optional(Type.String()),
});
const providerSyncSchema = Type.Object({
  start_date: Type.Optional(Type.String()),
  end_date: Type.Optional(Type.String()),
  pull_remote: Type.Optional(Type.Boolean()),
  source_device: Type.Optional(Type.String()),
  metrics: Type.Optional(Type.Array(healthMetricSchema)),
});

const providerDisplay: Record<string, { name: string; image: string }> = {
  "apple-health": {
    name: "Apple Watch / Apple Health",
    image:
      "https://images.unsplash.com/photo-1434493789847-2f02dc6ca35d?w=600&q=80",
  },
  "health-connect": {
    name: "Health Connect",
    image:
      "https://images.unsplash.com/photo-1510017803434-a899398421b3?w=600&q=80",
  },
  fitbit: {
    name: "Fitbit",
    image:
      "https://images.unsplash.com/photo-1575311373937-040b8e1fd5b2?w=600&q=80",
  },
  "google-fit": {
    name: "Google Fit",
    image:
      "https://images.unsplash.com/photo-1510017803434-a899398421b3?w=600&q=80",
  },
  garmin: {
    name: "Garmin",
    image:
      "https://images.unsplash.com/photo-1557438159-8664b4c7301c?w=600&q=80",
  },
  "this-phone": {
    name: "This Phone",
    image:
      "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=600&q=80",
  },
  "qr-import": {
    name: "QR Import",
    image:
      "https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?w=600&q=80",
  },
};

const providerConfigured = (provider: string) =>
  provider === "fitbit"
    ? Boolean(config.fitbit.clientId && config.fitbit.clientSecret)
    : provider === "google-fit"
      ? Boolean(config.googleClientId && config.googleClientSecret)
      : provider === "garmin"
        ? Boolean(
            config.garmin.enabled &&
            config.garmin.clientId &&
            config.garmin.clientSecret,
          )
        : [
            "apple-health",
            "health-connect",
            "this-phone",
            "qr-import",
          ].includes(provider);

const decodeQrPayload = (
  qrPayload: string,
): { metrics: any[]; source_device?: string; batch_id?: string } => {
  const value = qrPayload.trim();
  if (!value) throw new AppError(400, "QR payload is empty");
  const candidates = [value];
  try {
    candidates.push(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    /* raw JSON may still be valid */
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.metrics) &&
        parsed.metrics.length
      ) {
        return parsed;
      }
    } catch {
      /* try the next representation */
    }
  }
  throw new AppError(
    400,
    "QR payload must contain valid JSON health sync data",
  );
};

const wearableConnection = (record: Record<string, any>) => {
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? record.metadata
      : {};
  const deviceName = String(
    record.device_name ??
      record.source_device ??
      metadata.device_name ??
      metadata.source_device ??
      "",
  );
  return serialize({
    id: record._id ?? record.id,
    user_id: String(record.user_id ?? ""),
    provider: String(record.provider ?? ""),
    status: String(record.status ?? "disconnected"),
    device_name: deviceName,
    scopes: Array.isArray(record.scopes) ? record.scopes : [],
    provider_user_id: record.provider_user_id ?? null,
    connected_at: record.connected_at ?? null,
    disconnected_at: record.disconnected_at ?? null,
    last_synced_at: record.last_synced_at ?? null,
    last_sync_status: String(record.last_sync_status ?? "idle"),
    last_sync_message: String(record.last_sync_message ?? ""),
    permission_granted: Boolean(
      record.permission_granted ?? metadata.permission_granted ?? false,
    ),
    source_device: String(record.source_device ?? deviceName),
    platform: String(record.platform ?? ""),
    metadata,
    created_at: record.created_at ?? new Date(),
    updated_at: record.updated_at ?? record.created_at ?? new Date(),
  });
};

export default async function wearableRoutes(
  app: FastifyInstance,
): Promise<void> {
  const connectionCollection = () =>
    app.mongo.collection("user_provider_connections");

  const list = async (userId: string) => {
    const records = await connectionCollection()
      .find({ user_id: userId })
      .toArray();
    const byProvider = new Map(
      records.map((record) => [String(record.provider), record]),
    );
    return providers.map((provider) => {
      const record = byProvider.get(provider) ?? {};
      const metadata = record.metadata ?? {};
      const deviceName = String(
        record.device_name ??
          record.source_device ??
          metadata.device_name ??
          "",
      );
      return {
        provider,
        display_name: provider
          .split("-")
          .map((word) => word[0]?.toUpperCase() + word.slice(1))
          .join(" "),
        connection_type: ["fitbit", "google-fit", "garmin"].includes(provider)
          ? "oauth"
          : "native",
        status: record.status ?? "not_connected",
        connected: record.status === "connected",
        needs_permission:
          ["apple-health", "health-connect", "this-phone"].includes(provider) &&
          !record.permission_granted,
        configured: providerConfigured(provider),
        connected_at: record.connected_at ?? null,
        disconnected_at: record.disconnected_at ?? null,
        last_synced_at: record.last_synced_at ?? null,
        last_error: String(record.last_error ?? ""),
        last_sync_message: String(record.last_sync_message ?? ""),
        permission_granted: Boolean(record.permission_granted),
        device_name: deviceName,
        source_device: String(record.source_device ?? deviceName),
        platform: String(record.platform ?? ""),
        metadata,
      };
    });
  };

  const longevityWearables = async (userId: string) => {
    const connections = await connectionCollection()
      .find({ user_id: userId })
      .sort({ updated_at: -1, connected_at: -1, last_synced_at: -1 })
      .toArray();
    const byProvider = new Map(
      connections.map((connection) => [
        String(connection.provider),
        connection,
      ]),
    );
    const activeConnection = connections.find(
      (connection) => String(connection.status).toLowerCase() === "connected",
    );
    let lastSyncedAt: Date | null = null;
    for (const connection of connections) {
      const candidate = connection.last_synced_at;
      if (
        candidate instanceof Date &&
        (!lastSyncedAt || candidate > lastSyncedAt)
      ) {
        lastSyncedAt = candidate;
      }
    }
    const current = await app.mongo
      .collection("health_metric_current")
      .findOne({ user_id: userId });
    const totalRecords = Array.isArray(current?.records)
      ? current.records.length
      : current
        ? 1
        : 0;
    const profile = await app.mongo
      .collection("longevity_os_profiles")
      .findOne({ user_id: userId });
    const cachedMessage = String(profile?.wearables?.sync_message ?? "").trim();
    return {
      devices: providers.map((provider) => {
        const connection = byProvider.get(provider);
        const active = Boolean(
          connection &&
          String(connection.status).toLowerCase() === "connected" &&
          connection._id?.toString() === activeConnection?._id?.toString(),
        );
        const metadata = connection?.metadata ?? {};
        const deviceName = String(
          connection?.device_name ??
            connection?.source_device ??
            metadata.device_name ??
            metadata.source_device ??
            "",
        );
        const failed =
          String(connection?.last_sync_status ?? "").toLowerCase() === "failed";
        return {
          id: provider,
          name:
            active && deviceName ? deviceName : providerDisplay[provider]!.name,
          status: failed ? "ERROR" : active ? "CONNECTED" : "CONNECT",
          active,
          image: providerDisplay[provider]!.image,
          device_name: deviceName,
          source_device: deviceName,
          platform: String(connection?.platform ?? metadata.platform ?? ""),
        };
      }),
      last_synced_at: lastSyncedAt,
      has_data: totalRecords > 0,
      sync_message:
        cachedMessage ||
        (totalRecords
          ? `${totalRecords} normalized wearable records available.`
          : "No data synced yet. Add a wearable and press sync to import health data into Longevity OS."),
    };
  };

  app.get("/integrations", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    return { items: serialize(await list(String(user._id))) };
  });

  const connectNative = async (request: any, forcedProvider?: string) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const body = (request.body ?? {}) as Record<string, unknown>;
    const provider = forcedProvider ?? String(body.provider ?? "");
    if (!providers.includes(provider)) {
      throw new AppError(400, "Unsupported provider");
    }
    const now = new Date();
    await connectionCollection().updateOne(
      { user_id: String(user._id), provider },
      {
        $set: {
          status: "connected",
          permission_granted: body.permission_granted ?? true,
          source_device: String(body.source_device ?? body.device_name ?? ""),
          platform: String(body.platform ?? ""),
          metadata: body.metadata ?? {},
          connected_at: now,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
    const connection = await connectionCollection().findOne({
      user_id: String(user._id),
      provider,
    });
    if (!connection) {
      throw new AppError(500, "Wearable connection was not saved");
    }
    return wearableConnection(connection);
  };

  app.post(
    "/integrations/native/connected",
    {
      schema: {
        body: Type.Object({
          provider: Type.String(),
          permission_granted: Type.Optional(Type.Boolean()),
          source_device: Type.Optional(Type.String()),
          platform: Type.Optional(Type.String()),
          metadata: Type.Optional(
            Type.Object({}, { additionalProperties: true }),
          ),
        }),
      },
    },
    (request) => connectNative(request),
  );
  app.post("/integrations/:provider/connect-local", (request) =>
    connectNative(request, (request.params as { provider: string }).provider),
  );
  for (const provider of ["apple-health", "health-connect"]) {
    app.post(
      `/wearables/${provider === "apple-health" ? "apple-health" : "health-connect"}/sync`,
      { schema: { body: nativeSyncSchema } },
      async (request) => {
        return ingest(request, provider);
      },
    );
  }
  app.post(
    "/wearables/this-phone/sync",
    { schema: { body: nativeSyncSchema } },
    (request) => ingest(request, "this-phone"),
  );
  app.post(
    "/wearables/qr-import/sync",
    {
      schema: {
        body: Type.Object({
          qr_payload: Type.String(),
          source_device: Type.Optional(Type.String()),
        }),
      },
    },
    (request) => {
      const body = request.body as Record<string, any>;
      const decoded = decodeQrPayload(String(body.qr_payload ?? ""));
      request.body = {
        ...body,
        metrics: decoded.metrics,
        source_device:
          String(body.source_device ?? "") ||
          String(decoded.source_device ?? "QR Import"),
        batch_id: decoded.batch_id ?? body.batch_id,
      };
      return ingest(request, "qr-import");
    },
  );
  app.post(
    "/integrations/native/samples",
    { schema: { body: nativeSamplesSchema } },
    (request) => ingest(request),
  );

  async function ingest(request: any, forcedProvider?: string) {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const body = request.body as Record<string, any>;
    let provider = forcedProvider ?? String(body.provider ?? "this-phone");
    if (!forcedProvider && provider === "this-phone") {
      provider =
        String(body.platform ?? "")
          .trim()
          .toLowerCase() === "ios"
          ? "apple-health"
          : "health-connect";
    }
    if (!providers.includes(provider)) {
      throw new AppError(400, "Unsupported provider");
    }
    const metrics = Array.isArray(body.metrics)
      ? body.metrics
      : Array.isArray(body.samples)
        ? body.samples
        : [];
    if (!metrics.length) {
      throw new AppError(400, "At least one metric is required");
    }
    const now = new Date();
    const stored = await storeHealthMetrics(
      app,
      String(user._id),
      provider,
      metrics,
      String(body.source_device ?? ""),
    );
    await connectionCollection().updateOne(
      { user_id: String(user._id), provider },
      { $set: { status: "connected", last_synced_at: now, updated_at: now } },
      { upsert: true },
    );
    return {
      provider,
      user_id: String(user._id),
      synced_records: stored.inserted,
      skipped_duplicates: stored.skipped,
      last_synced_at: now,
      connection_status: "connected",
      message: `${provider} samples synced successfully.`,
    };
  }

  app.delete("/integrations/:provider", async (request) =>
    disconnect(request, (request.params as { provider: string }).provider),
  );
  app.delete("/wearables/:provider/connection", async (request) =>
    disconnect(request, (request.params as { provider: string }).provider),
  );
  async function disconnect(request: any, provider: string) {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const connection = await connectionCollection().findOneAndUpdate(
      { user_id: String(user._id), provider },
      {
        $set: {
          status: "disconnected",
          disconnected_at: new Date(),
          permission_granted: false,
        },
      },
      { returnDocument: "after" },
    );
    await app.mongo
      .collection("provider_tokens")
      .deleteOne({ user_id: String(user._id), provider });
    return {
      provider,
      disconnected: true,
      status: "disconnected",
      device_name: String(
        connection?.device_name ?? connection?.source_device ?? "",
      ),
      source_device: String(
        connection?.source_device ?? connection?.device_name ?? "",
      ),
      platform: String(connection?.platform ?? ""),
      disconnected_at: connection?.disconnected_at ?? null,
      permission_granted: false,
      message: "Provider disconnected by user.",
    };
  }

  app.get("/wearables/connections", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    return { connections: serialize(await list(String(user._id))) };
  });
  app.get("/health-data/me", async (request) => healthData(request));
  app.get("/health-data/me/summary", async (request) =>
    healthData(request, true),
  );
  app.get("/health-data/me/:metricType", async (request) =>
    healthData(
      request,
      false,
      (request.params as { metricType: string }).metricType,
    ),
  );
  async function healthData(
    request: any,
    summary = false,
    metricType?: string,
  ) {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const query = request.query as Record<string, any>;
    const targetUserId = String(query.user_id ?? user._id);
    if (targetUserId !== String(user._id) && !user.is_admin) {
      throw new AppError(
        403,
        "Admin access required for cross-user wearable access",
      );
    }
    const snapshot = await app.mongo
      .collection("health_samples")
      .findOne({ user_id: targetUserId });
    const requestedMetric = metricType ?? query.metric_type;
    const start = query.start_date
      ? new Date(`${String(query.start_date)}T00:00:00.000Z`).getTime()
      : null;
    const end = query.end_date
      ? new Date(`${String(query.end_date)}T23:59:59.999Z`).getTime()
      : null;
    const records = (snapshot?.records ?? []).filter((record: any) => {
      if (requestedMetric && record.metric_type !== requestedMetric) {
        return false;
      }
      if (query.provider && record.provider !== query.provider) return false;
      const startTime = new Date(
        record.start_time ?? record.started_at ?? "",
      ).getTime();
      const endTime = new Date(
        record.end_time ?? record.ended_at ?? "",
      ).getTime();
      if (start !== null && (!Number.isFinite(endTime) || endTime < start)) {
        return false;
      }
      if (end !== null && (!Number.isFinite(startTime) || startTime > end)) {
        return false;
      }
      return true;
    });
    if (summary) {
      const groups = new Map<string, any>();
      for (const record of records) {
        const key = `${record.metric_type}|${record.provider}`;
        const group = groups.get(key) ?? {
          metric_type: String(record.metric_type ?? ""),
          provider: String(record.provider ?? ""),
          records: 0,
          values: [] as number[],
          units: new Map<string, number>(),
          latest_end_time: null as Date | null,
          latest_value: null as number | null,
        };
        group.records += 1;
        if (typeof record.value === "number") group.values.push(record.value);
        const unit = String(record.unit ?? "");
        if (unit) group.units.set(unit, (group.units.get(unit) ?? 0) + 1);
        const recordEnd = new Date(record.end_time ?? record.ended_at ?? "");
        if (
          !Number.isNaN(recordEnd.getTime()) &&
          (!group.latest_end_time || recordEnd >= group.latest_end_time)
        ) {
          group.latest_end_time = recordEnd;
          group.latest_value =
            typeof record.value === "number" ? record.value : null;
        }
        groups.set(key, group);
      }
      return {
        user_id: targetUserId,
        from_date: query.start_date ?? null,
        to_date: query.end_date ?? null,
        items: [...groups.values()].map((group) => ({
          metric_type: group.metric_type,
          provider: group.provider,
          records: group.records,
          total_value: group.values.reduce(
            (sum: number, value: number) => sum + value,
            0,
          ),
          average_value: group.values.length
            ? group.values.reduce(
                (sum: number, value: number) => sum + value,
                0,
              ) / group.values.length
            : 0,
          min_value: group.values.length ? Math.min(...group.values) : null,
          max_value: group.values.length ? Math.max(...group.values) : null,
          unit:
            [...group.units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
            "",
          latest_end_time: group.latest_end_time,
          latest_value: group.latest_value,
        })),
      };
    }
    return { items: serialize(records), total: records.length };
  }
  app.get("/longevity-os/wearables", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    return longevityWearables(String(user._id));
  });
  app.post(
    "/longevity-os/wearables/sync",
    {
      schema: {
        body: Type.Optional(
          Type.Object({
            provider: Type.Optional(providerSchema),
            providers: Type.Optional(Type.Array(providerSchema)),
          }),
        ),
      },
    },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "longevity",
        "Your current plan does not include Longevity OS access",
      );
      const userId = String(user._id);
      const body = (request.body ?? {}) as Record<string, any>;
      const selected = [
        ...(body.provider ? [String(body.provider)] : []),
        ...(Array.isArray(body.providers) ? body.providers.map(String) : []),
      ].filter((provider, index, values) => values.indexOf(provider) === index);
      for (const provider of selected) {
        if (!providers.includes(provider)) {
          throw new AppError(400, `Unsupported provider: ${provider}`);
        }
      }
      let connections = await connectionCollection()
        .find({
          user_id: userId,
          status: "connected",
          ...(selected.length ? { provider: { $in: selected } } : {}),
        })
        .toArray();
      if (selected.length && !connections.length) {
        const now = new Date();
        for (const provider of selected) {
          const deviceName = [
            "apple-health",
            "health-connect",
            "this-phone",
            "qr-import",
          ].includes(provider)
            ? providerDisplay[provider]!.name
            : "";
          await connectionCollection().updateOne(
            { user_id: userId, provider },
            {
              $set: {
                status: "connected",
                permission_granted: true,
                device_name: deviceName,
                source_device: deviceName,
                connected_at: now,
                updated_at: now,
                last_sync_status: "idle",
                last_sync_message: ["fitbit", "google-fit", "garmin"].includes(
                  provider,
                )
                  ? `${providerDisplay[provider]!.name} requires OAuth login through the connect endpoint.`
                  : `${providerDisplay[provider]!.name} connected successfully. Press sync to import health data.`,
              },
              $setOnInsert: { created_at: now },
            },
            { upsert: true },
          );
        }
        connections = await connectionCollection()
          .find({
            user_id: userId,
            provider: { $in: selected },
            status: "connected",
          })
          .toArray();
      }
      if (!connections.length) {
        throw new AppError(
          400,
          "Select a wearable first, then sync your health data",
        );
      }
      for (const connection of connections) {
        const provider = String(connection.provider ?? "");
        if (!["fitbit", "google-fit", "garmin"].includes(provider)) continue;
        try {
          await syncRemoteProvider(app, userId, provider);
        } catch (error) {
          const now = new Date();
          await connectionCollection().updateOne(
            { _id: connection._id },
            {
              $set: {
                last_sync_status: "failed",
                last_sync_message:
                  error instanceof Error ? error.message : String(error),
                updated_at: now,
              },
            },
          );
          request.log.error(
            { error, provider, userId },
            "wearable sync failed",
          );
        }
      }
      return longevityWearables(userId);
    },
  );

  const connectOAuth = async (request: any, forcedProvider?: string) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const provider = forcedProvider ?? String(request.params.provider);
    if (["apple-health", "health-connect", "this-phone"].includes(provider)) {
      return {
        provider,
        connection_type: "native",
        authorization_url: null,
        state: null,
        expires_at: null,
        message:
          "Continue in the mobile app to approve native health permissions.",
      };
    }
    if (provider === "qr-import") {
      return {
        provider,
        connection_type: "import",
        authorization_url: null,
        state: null,
        expires_at: null,
        message:
          "Continue in the app to import a supported QR or file payload.",
      };
    }
    if (!["fitbit", "google-fit", "garmin"].includes(provider)) {
      throw new AppError(400, "Unsupported integration provider");
    }
    if (!providerConfigured(provider)) {
      throw new AppError(503, "provider_not_configured");
    }
    const state = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const scopes =
      provider === "fitbit"
        ? config.fitbit.scopes
        : provider === "google-fit"
          ? config.googleFit.scopes
          : config.garmin.scopes;
    await connectionCollection().updateOne(
      { user_id: String(user._id), provider },
      {
        $set: {
          oauth_state: state,
          scopes,
          status: "pending",
          metadata: { oauth_expires_at: expiresAt.toISOString() },
          last_sync_status: "idle",
          last_sync_message: "Waiting for provider authorization callback.",
          updated_at: new Date(),
        },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true },
    );
    const authUrl =
      provider === "fitbit"
        ? config.fitbit.authUrl
        : provider === "google-fit"
          ? config.googleFit.authUri
          : config.garmin.authorizeUrl;
    const url = new URL(authUrl);
    url.searchParams.set(
      "client_id",
      provider === "fitbit"
        ? config.fitbit.clientId
        : provider === "google-fit"
          ? config.googleClientId
          : config.garmin.clientId,
    );
    url.searchParams.set(
      "redirect_uri",
      provider === "fitbit"
        ? config.fitbit.redirectUri
        : provider === "google-fit"
          ? config.googleFit.redirectUri
          : config.garmin.redirectUri,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scopes.join(" "));
    if (provider === "google-fit") {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
    }
    const result: Record<string, unknown> = {
      provider,
      authorization_url: url.toString(),
      state,
      expires_at: expiresAt,
    };
    if (!forcedProvider) {
      result.connection_type = "oauth";
      result.message = "Continue in browser to complete provider login.";
    }
    return result;
  };

  app.get("/integrations/:provider/connect", (request) =>
    connectOAuth(request),
  );

  const oauthCallback = async (request: any, forcedProvider?: string) => {
    const provider = forcedProvider ?? String(request.params.provider);
    const { code, state } = request.query as any;
    if (!code || !state) {
      throw new AppError(400, "OAuth code and state are required");
    }
    const connection = await connectionCollection().findOne({
      provider,
      oauth_state: String(state),
    });
    if (!connection) throw new AppError(400, "Invalid or expired OAuth state");
    const tokenUrl =
      provider === "fitbit"
        ? config.fitbit.tokenUrl
        : provider === "google-fit"
          ? config.googleFit.tokenUri
          : config.garmin.tokenUrl;
    const clientId =
      provider === "fitbit"
        ? config.fitbit.clientId
        : provider === "google-fit"
          ? config.googleClientId
          : config.garmin.clientId;
    const clientSecret =
      provider === "fitbit"
        ? config.fitbit.clientSecret
        : provider === "google-fit"
          ? config.googleClientSecret
          : config.garmin.clientSecret;
    const redirectUri =
      provider === "fitbit"
        ? config.fitbit.redirectUri
        : provider === "google-fit"
          ? config.googleFit.redirectUri
          : config.garmin.redirectUri;
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (provider === "fitbit") {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    }
    const body = new URLSearchParams({
      code: String(code),
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    if (provider !== "fitbit") {
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);
    }
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new AppError(
        502,
        `${provider} token exchange failed (${response.status})`,
      );
    }
    const token = (await response.json()) as any;
    const now = new Date();
    await app.mongo.collection("provider_tokens").updateOne(
      { user_id: String(connection.user_id), provider },
      {
        $set: {
          access_token: encryptWearableToken(String(token.access_token)),
          refresh_token: token.refresh_token
            ? encryptWearableToken(String(token.refresh_token))
            : "",
          expires_at: token.expires_in
            ? new Date(Date.now() + Number(token.expires_in) * 1000)
            : null,
          scopes: token.scope ?? "",
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
    await connectionCollection().updateOne(
      { _id: connection._id },
      {
        $set: { status: "connected", connected_at: now, updated_at: now },
        $unset: { oauth_state: "" },
      },
    );
    const updatedConnection = await connectionCollection().findOne({
      _id: connection._id,
    });
    if (!updatedConnection) {
      throw new AppError(404, "Wearable connection not found");
    }
    return wearableConnection(updatedConnection);
  };

  app.get("/integrations/:provider/callback", (request) =>
    oauthCallback(request),
  );

  app.post("/integrations/:provider/sync", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const provider = String((request.params as any).provider);
    if (
      ["google-fit", "garmin"].includes(provider) &&
      !providerConfigured(provider)
    ) {
      throw new AppError(503, "provider_not_configured");
    }
    if (
      ["apple-health", "health-connect", "this-phone", "qr-import"].includes(
        provider,
      )
    ) {
      const connection = await connectNative(request, provider);
      return {
        provider,
        user_id: String(user._id),
        synced_records: 0,
        skipped_duplicates: 0,
        connection_status: String((connection as any)?.status ?? "connected"),
        last_synced_at: (connection as any)?.last_synced_at ?? null,
        message: "Sync is initiated from the mobile app for this provider.",
      };
    }
    if (!["fitbit", "google-fit", "garmin"].includes(provider)) {
      throw new AppError(400, "Unsupported integration provider");
    }
    const now = new Date();
    const result = await app.mongo.collection("sync_jobs").insertOne({
      user_id: String(user._id),
      provider,
      job_type: "sync-provider-data",
      status: "queued",
      created_at: now,
      updated_at: now,
    });
    return {
      provider,
      user_id: String(user._id),
      connection_status: "syncing",
      message: `${provider === "fitbit" ? "Fitbit" : provider === "google-fit" ? "Google Fit" : "Garmin"} sync queued with job ${String(result.insertedId)}.`,
    };
  });
  app.post(
    "/integrations/import/qr",
    {
      schema: {
        body: Type.Object({
          qr_payload: Type.String(),
          source_device: Type.Optional(Type.String()),
        }),
      },
    },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "longevity",
        "Your current plan does not include Longevity OS access",
      );
      const body = request.body as Record<string, any>;
      const decoded = decodeQrPayload(String(body.qr_payload ?? ""));
      const result = await app.mongo.collection("sync_jobs").insertOne({
        user_id: String(user._id),
        provider: "qr-import",
        job_type: "import-provider-data",
        status: "queued",
        metrics: decoded.metrics,
        source_device:
          String(body.source_device ?? "") ||
          String(decoded.source_device ?? "QR Import"),
        batch_id: decoded.batch_id ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      return {
        provider: "qr-import",
        user_id: String(user._id),
        connection_status: "syncing",
        message: `QR import queued with job ${String(result.insertedId)}.`,
      };
    },
  );
  app.post(
    "/integrations/import/file",
    {
      schema: {
        body: Type.Object({
          content_base64: Type.String(),
          file_name: Type.Optional(Type.String()),
          provider: Type.Optional(Type.String()),
          source_device: Type.Optional(Type.String()),
        }),
      },
    },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "longevity",
        "Your current plan does not include Longevity OS access",
      );
      const body = request.body as Record<string, any>;
      let parsed: any;
      try {
        parsed = JSON.parse(
          Buffer.from(String(body.content_base64 ?? ""), "base64").toString(
            "utf8",
          ),
        );
      } catch {
        throw new AppError(
          400,
          "Imported file must be base64-encoded JSON health data",
        );
      }
      const metrics = Array.isArray(parsed) ? parsed : parsed?.metrics;
      if (!Array.isArray(metrics) || !metrics.length) {
        throw new AppError(
          400,
          "Imported file does not contain any health metrics",
        );
      }
      const result = await app.mongo.collection("sync_jobs").insertOne({
        user_id: String(user._id),
        provider: "qr-import",
        job_type: "import-provider-data",
        status: "queued",
        metrics,
        source_device:
          String(body.source_device ?? "") ||
          String(body.file_name ?? "") ||
          "Imported File",
        batch_id: String(parsed?.batch_id ?? "") || null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      return {
        provider: "qr-import",
        user_id: String(user._id),
        connection_status: "syncing",
        message: `File import queued with job ${String(result.insertedId)}.`,
      };
    },
  );

  for (const [path, provider] of [
    ["/webhooks/fitbit", "fitbit"],
    ["/webhooks/google-fit", "google-fit"],
  ] as const) {
    app.post(path, async (request) => {
      if (!providerConfigured(provider)) {
        throw new AppError(503, "provider_not_configured");
      }
      await app.mongo.collection("integration_audit_logs").insertOne({
        provider,
        event: request.body,
        headers: request.headers,
        created_at: new Date(),
      });
      return {
        accepted: true,
        provider,
        queued: false,
        message: `${provider === "fitbit" ? "Fitbit" : "Google Fit"} webhook received.`,
        events: Array.isArray(request.body) ? request.body.length : 1,
      };
    });
  }
  app.post(
    "/wearables/garmin/webhook",
    {
      schema: {
        body: Type.Object({
          provider_user_id: Type.Optional(Type.String()),
          external_user_id: Type.Optional(Type.String()),
          event_type: Type.Optional(Type.String()),
          metrics: Type.Optional(Type.Array(healthMetricSchema)),
          payload: Type.Optional(
            Type.Object({}, { additionalProperties: true }),
          ),
        }),
      },
    },
    async (request) => {
      if (!providerConfigured("garmin")) {
        throw new AppError(503, "provider_not_configured");
      }
      if (config.garmin.webhookSecret) {
        const signature = String(
          request.headers["x-garmin-signature"] ??
            request.headers["x-hub-signature-256"] ??
            "",
        ).trim();
        if (!signature) {
          throw new AppError(401, "Missing Garmin webhook signature");
        }
        const expected = createHmac("sha256", config.garmin.webhookSecret)
          .update(request.rawBody ?? Buffer.alloc(0))
          .digest("hex");
        const provided = signature.split("=").at(-1) ?? "";
        const expectedBytes = Buffer.from(expected, "hex");
        const providedBytes = Buffer.from(provided, "hex");
        if (
          expectedBytes.length !== providedBytes.length ||
          !timingSafeEqual(expectedBytes, providedBytes)
        ) {
          throw new AppError(401, "Invalid Garmin webhook signature");
        }
      }
      const body = request.body as Record<string, any>;
      let connection = body.provider_user_id
        ? await connectionCollection().findOne({
            provider: "garmin",
            provider_user_id: String(body.provider_user_id),
          })
        : null;
      if (!connection && body.external_user_id) {
        const user = await app.mongo.collection("users").findOne({
          email: String(body.external_user_id).trim().toLowerCase(),
        });
        if (user) {
          connection = await connectionCollection().findOne({
            provider: "garmin",
            user_id: String(user._id),
          });
        }
      }
      if (!connection) {
        throw new AppError(404, "Garmin user mapping not found");
      }
      const metrics = Array.isArray(body.metrics) ? body.metrics : [];
      let syncedRecords = 0;
      if (metrics.length) {
        syncedRecords = (
          await storeHealthMetrics(
            app,
            String(connection.user_id),
            "garmin",
            metrics,
            "Garmin Webhook",
          )
        ).inserted;
      } else {
        await app.mongo.collection("sync_jobs").insertOne({
          user_id: String(connection.user_id),
          provider: "garmin",
          job_type: "sync-provider-data",
          status: "queued",
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
      await app.mongo.collection("integration_audit_logs").insertOne({
        provider: "garmin",
        event: body,
        headers: request.headers,
        created_at: new Date(),
      });
      return {
        accepted: true,
        queued: !metrics.length,
        synced_records: syncedRecords,
        message: "Garmin webhook processed.",
      };
    },
  );
  app.post("/wearables/:provider/demo-connect", (request) =>
    connectNative(request, (request.params as any).provider),
  );
  app.post("/wearables/:provider/connect-local", (request) =>
    connectNative(request, (request.params as any).provider),
  );
  for (const provider of ["fitbit", "google-fit", "garmin"]) {
    app.get(`/wearables/${provider}/connect`, (request) =>
      connectOAuth(request, provider),
    );
    app.get(`/wearables/${provider}/callback`, (request) =>
      oauthCallback(request, provider),
    );
    app.post(
      `/wearables/${provider}/sync`,
      { schema: { body: providerSyncSchema } },
      async (request) => {
        const user = await app.requireFeature(
          request,
          "longevity",
          "Your current plan does not include Longevity OS access",
        );
        const now = new Date();
        const body = (request.body ?? {}) as Record<string, any>;
        const metrics = Array.isArray(body.metrics) ? body.metrics : [];
        if (metrics.length) {
          const stored = await storeHealthMetrics(
            app,
            String(user._id),
            provider,
            metrics,
            String(body.source_device ?? ""),
          );
          await connectionCollection().updateOne(
            { user_id: String(user._id), provider },
            {
              $set: {
                status: "connected",
                last_synced_at: now,
                last_sync_status: "success",
                updated_at: now,
              },
            },
            { upsert: true },
          );
          return {
            provider,
            user_id: String(user._id),
            synced_records: stored.inserted,
            skipped_duplicates: stored.skipped,
            last_synced_at: null,
            message: `${provider === "fitbit" ? "Fitbit" : provider === "google-fit" ? "Google Fit" : "Garmin"} sync completed.`,
          };
        }
        const result = await app.mongo.collection("sync_jobs").insertOne({
          user_id: String(user._id),
          provider,
          status: "queued",
          created_at: now,
          updated_at: now,
        });
        return {
          provider,
          user_id: String(user._id),
          connection_status: "syncing",
          message: `Remote sync queued with job ${String(result.insertedId)}.`,
        };
      },
    );
  }
  app.post(
    "/admin/wearables/backfill-current-health-metrics",
    async (request) => {
      await app.requireAdmin(request);
      const force = String((request.query as any).force ?? "false") === "true";
      const processed = await backfillCurrentHealthMetrics(app, force);
      return {
        status: "success",
        processed,
        force,
        message: "Current health metrics backfill completed.",
      };
    },
  );
}
