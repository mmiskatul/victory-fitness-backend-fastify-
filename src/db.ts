import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
  MongoClient,
  type Collection,
  type Db,
  type IndexSpecification,
} from "mongodb";
import { config } from "./config.js";
import { AppError } from "./lib/errors.js";

export const collectionNames = [
  "users",
  "nutrition_plans",
  "nutrition_plan_jobs",
  "nutrition_progressive_plans",
  "nutrition_progressive_plan_jobs",
  "meal_analysis_entries",
  "strength_workout_plans",
  "app_content",
  "coaching_applications",
  "support_messages",
  "longevity_os_profiles",
  "coach_victor_threads",
  "coach_victor_archives",
  "journal_entries",
  "workouts",
  "challenges",
  "challenge_memberships",
  "challenge_chat_messages",
  "challenge_message_reactions",
  "community_posts",
  "community_comments",
  "community_reactions",
  "user_provider_connections",
  "provider_tokens",
  "health_metric_current",
  "health_samples",
  "sync_jobs",
  "sync_errors",
  "integration_audit_logs",
  "admin_audit_logs",
] as const;

const indexes: Array<{
  collection: (typeof collectionNames)[number];
  keys: IndexSpecification;
  options?: { unique?: boolean; sparse?: boolean };
}> = [
  {
    collection: "users",
    keys: { email: 1 },
    options: { unique: true, sparse: true },
  },
  { collection: "users", keys: { created_at: -1 } },
  { collection: "users", keys: { subscription_tier: 1, created_at: -1 } },
  {
    collection: "users",
    keys: { marketing_consent: 1, subscription_started_at: -1 },
  },
  { collection: "users", keys: { is_admin: 1, created_at: -1 } },
  { collection: "nutrition_plans", keys: { user_id: 1, created_at: -1 } },
  {
    collection: "nutrition_plans",
    keys: { user_id: 1, profile_hash: 1, created_at: -1 },
  },
  { collection: "nutrition_plan_jobs", keys: { user_id: 1, created_at: -1 } },
  {
    collection: "nutrition_plan_jobs",
    keys: { user_id: 1, profile_hash: 1, created_at: -1 },
  },
  { collection: "nutrition_plan_jobs", keys: { status: 1, updated_at: -1 } },
  {
    collection: "nutrition_progressive_plans",
    keys: { user_id: 1, created_at: -1 },
  },
  {
    collection: "nutrition_progressive_plans",
    keys: { user_id: 1, profile_hash: 1, created_at: -1 },
  },
  {
    collection: "nutrition_progressive_plan_jobs",
    keys: { user_id: 1, created_at: -1 },
  },
  {
    collection: "nutrition_progressive_plan_jobs",
    keys: { user_id: 1, profile_hash: 1, created_at: -1 },
  },
  {
    collection: "nutrition_progressive_plan_jobs",
    keys: { status: 1, updated_at: -1 },
  },
  { collection: "meal_analysis_entries", keys: { user_id: 1, created_at: -1 } },
  {
    collection: "strength_workout_plans",
    keys: { user_id: 1, created_at: -1 },
  },
  { collection: "app_content", keys: { key: 1 }, options: { unique: true } },
  { collection: "coaching_applications", keys: { user_id: 1, created_at: -1 } },
  { collection: "coaching_applications", keys: { status: 1, created_at: -1 } },
  { collection: "support_messages", keys: { user_id: 1, created_at: -1 } },
  { collection: "support_messages", keys: { status: 1, created_at: -1 } },
  {
    collection: "longevity_os_profiles",
    keys: { user_id: 1 },
    options: { unique: true },
  },
  { collection: "coach_victor_threads", keys: { user_id: 1, updated_at: -1 } },
  {
    collection: "coach_victor_archives",
    keys: { thread_id: 1, created_at: 1 },
  },
  { collection: "coach_victor_archives", keys: { user_id: 1, created_at: -1 } },
  { collection: "journal_entries", keys: { user_id: 1, created_at: -1 } },
  { collection: "workouts", keys: { created_at: -1 } },
  { collection: "workouts", keys: { visibility: 1, created_at: -1 } },
  { collection: "workouts", keys: { visibility: 1, tag: 1, created_at: -1 } },
  {
    collection: "workouts",
    keys: { vimeo_id: 1 },
    options: { unique: true, sparse: true },
  },
  { collection: "challenges", keys: { status: 1, created_at: -1 } },
  { collection: "challenges", keys: { category: 1, created_at: -1 } },
  { collection: "challenge_memberships", keys: { user_id: 1, joined_at: -1 } },
  {
    collection: "challenge_memberships",
    keys: { user_id: 1, status: 1, joined_at: -1 },
  },
  { collection: "challenge_memberships", keys: { challenge_id: 1, status: 1 } },
  {
    collection: "challenge_memberships",
    keys: { user_id: 1, challenge_id: 1 },
    options: { unique: true },
  },
  {
    collection: "challenge_chat_messages",
    keys: { challenge_id: 1, created_at: -1 },
  },
  {
    collection: "challenge_message_reactions",
    keys: { message_id: 1, created_at: -1 },
  },
  {
    collection: "challenge_message_reactions",
    keys: { message_id: 1, emoji: 1 },
  },
  {
    collection: "challenge_message_reactions",
    keys: { message_id: 1, user_id: 1, emoji: 1 },
    options: { unique: true },
  },
  { collection: "community_posts", keys: { created_at: -1 } },
  { collection: "community_posts", keys: { author_id: 1, created_at: -1 } },
  { collection: "community_posts", keys: { audience: 1, created_at: -1 } },
  { collection: "community_posts", keys: { flagged: 1, updated_at: -1 } },
  { collection: "community_comments", keys: { post_id: 1, created_at: 1 } },
  { collection: "community_comments", keys: { author_id: 1, created_at: -1 } },
  { collection: "community_reactions", keys: { post_id: 1, created_at: -1 } },
  {
    collection: "community_reactions",
    keys: { post_id: 1, user_id: 1 },
    options: { unique: true },
  },
  {
    collection: "user_provider_connections",
    keys: { user_id: 1, provider: 1 },
    options: { unique: true },
  },
  {
    collection: "user_provider_connections",
    keys: { provider: 1, status: 1, updated_at: -1 },
  },
  {
    collection: "user_provider_connections",
    keys: { user_id: 1, status: 1, updated_at: -1 },
  },
  {
    collection: "user_provider_connections",
    keys: { user_id: 1, platform: 1, status: 1 },
  },
  {
    collection: "user_provider_connections",
    keys: { user_id: 1, source_device: 1 },
  },
  {
    collection: "user_provider_connections",
    keys: { provider: 1, provider_user_id: 1 },
  },
  {
    collection: "user_provider_connections",
    keys: { provider: 1, oauth_state: 1 },
  },
  {
    collection: "provider_tokens",
    keys: { user_id: 1, provider: 1 },
    options: { unique: true },
  },
  {
    collection: "health_metric_current",
    keys: { user_id: 1 },
    options: { unique: true },
  },
  { collection: "health_metric_current", keys: { updated_at: -1 } },
  {
    collection: "health_samples",
    keys: { user_id: 1 },
    options: { unique: true },
  },
  { collection: "health_samples", keys: { updated_at: -1 } },
  {
    collection: "sync_jobs",
    keys: { user_id: 1, provider: 1, created_at: -1 },
  },
  { collection: "sync_jobs", keys: { status: 1, updated_at: -1 } },
  {
    collection: "sync_errors",
    keys: { user_id: 1, provider: 1, created_at: -1 },
  },
  { collection: "sync_errors", keys: { job_id: 1, created_at: -1 } },
  {
    collection: "integration_audit_logs",
    keys: { user_id: 1, provider: 1, created_at: -1 },
  },
  { collection: "admin_audit_logs", keys: { created_at: -1 } },
  {
    collection: "admin_audit_logs",
    keys: { resource: 1, resource_id: 1, created_at: -1 },
  },
];

export async function ensureIndexes(db: Db): Promise<void> {
  await db
    .collection("workouts")
    .updateMany({ vimeo_id: "" }, { $unset: { vimeo_id: "" } });
  await Promise.all(
    ["health_metric_current", "health_samples"].map(async (name) => {
      const collection = db.collection(name);
      const documents = await collection.find({}).toArray();
      const grouped = new Map<string, any[]>();
      for (const document of documents) {
        const userId = String(document.user_id ?? "").trim();
        if (!userId) continue;
        const records = Array.isArray(document.records)
          ? document.records
          : [document];
        grouped.set(userId, [...(grouped.get(userId) ?? []), ...records]);
      }
      for (const [userId, records] of grouped) {
        if (
          documents.filter(
            (document) => String(document.user_id ?? "") === userId,
          ).length <= 1 &&
          Array.isArray(
            documents.find(
              (document) => String(document.user_id ?? "") === userId,
            )?.records,
          )
        ) {
          continue;
        }
        const sorted = records.sort(
          (left, right) =>
            new Date(
              right.synced_at ?? right.end_time ?? right.updated_at ?? 0,
            ).getTime() -
            new Date(
              left.synced_at ?? left.end_time ?? left.updated_at ?? 0,
            ).getTime(),
        );
        await collection.deleteMany({ user_id: userId });
        await collection.insertOne({
          user_id: userId,
          records: sorted,
          record_count: sorted.length,
          updated_at: new Date(),
        });
      }
    }),
  );
  for (const index of indexes) {
    await db
      .collection(index.collection)
      .createIndex(index.keys, index.options);
  }
}

async function databasePlugin(app: FastifyInstance): Promise<void> {
  let client: MongoClient | null = null;
  let db: Db | null = null;

  if (config.mongodbUri) {
    client = new MongoClient(config.mongodbUri, {
      maxPoolSize: config.mongodbMaxPoolSize,
      minPoolSize: config.mongodbMinPoolSize,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    db = client.db(config.mongodbDb);
    await db.command({ ping: 1 });
    if (config.startupJobsEnabled) await ensureIndexes(db);
  }

  const collection = (name: string): Collection<any> => {
    if (!db) {
      throw new AppError(
        503,
        "MongoDB Atlas is not configured. Set MONGODB_URI in backend/.env to your MongoDB Atlas connection string.",
      );
    }
    return db.collection(name);
  };

  app.decorate("mongo", { client, db, collection, configured: Boolean(db) });
  app.addHook("onClose", async () => {
    await client?.close();
  });
}

export default fp(databasePlugin, { name: "database" });
