import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { config } from "../config.js";

type Message = Record<string, any>;

const s3Enabled = () =>
  Boolean(
    config.aws.bucket &&
    config.aws.region &&
    config.aws.accessKeyId &&
    config.aws.secretAccessKey,
  );

const s3Client = () =>
  new S3Client({
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
  });

const loadS3Messages = async (
  bucket: string,
  key: string,
): Promise<Message[]> => {
  if (!bucket || !key || !s3Enabled()) return [];
  const response = await s3Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const parsed = JSON.parse(
    (await response.Body?.transformToString()) || "{}",
  ) as {
    messages?: Message[];
  };
  return Array.isArray(parsed.messages)
    ? parsed.messages.map((message) => ({
        ...message,
        created_at: message.created_at
          ? new Date(message.created_at)
          : message.created_at,
      }))
    : [];
};

const putSnapshot = async (
  userId: string,
  threadId: string,
  messages: Message[],
  createdAt: Date,
) => {
  const key = `${config.aws.prefix}/${userId}/${threadId}/snapshots/${createdAt
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "Z")}.json`;
  await s3Client().send(
    new PutObjectCommand({
      Bucket: config.aws.bucket,
      Key: key,
      ContentType: "application/json",
      Body: JSON.stringify({
        user_id: userId,
        thread_id: threadId,
        created_at: createdAt.toISOString(),
        messages,
      }),
    }),
  );
  return key;
};

export const recentCoachMessages = (thread: Message | null): Message[] => {
  if (!thread) return [];
  if (Array.isArray(thread.recent_messages)) return thread.recent_messages;
  return Array.isArray(thread.messages) ? thread.messages : [];
};

export async function fullCoachMessages(
  app: FastifyInstance,
  thread: Message | null,
): Promise<Message[]> {
  if (!thread) return [];
  const snapshotKey = String(thread.latest_snapshot_s3_key ?? "");
  const snapshotBucket = String(thread.latest_snapshot_s3_bucket ?? "");
  if (snapshotKey && snapshotBucket) {
    return loadS3Messages(snapshotBucket, snapshotKey);
  }
  const archives = await app.mongo
    .collection("coach_victor_archives")
    .find({ thread_id: String(thread._id) })
    .sort({ created_at: 1 })
    .toArray();
  const archived: Message[] = [];
  for (const archive of archives) {
    if (String(archive.storage_backend ?? "mongodb") === "s3") {
      archived.push(
        ...(await loadS3Messages(
          String(archive.s3_bucket ?? config.aws.bucket),
          String(archive.s3_key ?? ""),
        )),
      );
    } else if (Array.isArray(archive.payload)) {
      archived.push(...archive.payload);
    }
  }
  return [...archived, ...recentCoachMessages(thread)];
}

export async function saveCoachMessages(
  app: FastifyInstance,
  thread: Message | null,
  userId: string,
  appendedMessages: Message[],
  now: Date,
): Promise<ObjectId> {
  const threadId =
    thread?._id instanceof ObjectId ? thread._id : new ObjectId();
  const recentLimit = Math.max(config.coachRecentMessageLimit, 2);
  const fullMessages = thread
    ? [...(await fullCoachMessages(app, thread)), ...appendedMessages]
    : appendedMessages;

  if (s3Enabled()) {
    const snapshotKey = await putSnapshot(
      userId,
      String(threadId),
      fullMessages,
      now,
    );
    await app.mongo.collection("coach_victor_threads").updateOne(
      { _id: threadId },
      {
        $set: {
          user_id: userId,
          recent_messages: fullMessages.slice(-recentLimit),
          recent_message_count: Math.min(fullMessages.length, recentLimit),
          latest_snapshot_s3_bucket: config.aws.bucket,
          latest_snapshot_s3_key: snapshotKey,
          snapshot_message_count: fullMessages.length,
          last_snapshot_at: now,
          storage_mode: "s3_snapshot",
          updated_at: now,
          last_message_at: now,
        },
        $unset: { messages: "" },
        $setOnInsert: {
          created_at: thread?.created_at ?? now,
          archive_count: 0,
        },
      },
      { upsert: true },
    );
    return threadId;
  }

  // Only archive the currently resident messages. Older batches are already in
  // coach_victor_archives and must not be inserted again on every chat turn.
  let resident = [...recentCoachMessages(thread), ...appendedMessages];
  if (!thread) resident = [...appendedMessages];
  let archivedAt: Date | null = null;
  let archiveIncrement = 0;
  if (resident.length > recentLimit) {
    const batchSize = Math.max(config.coachArchiveBatchSize, 2);
    let archiveCount = Math.max(resident.length - recentLimit, batchSize);
    archiveCount = Math.min(archiveCount, resident.length - 2);
    if (archiveCount % 2) archiveCount -= 1;
    if (archiveCount > 0) {
      const payload = resident.slice(0, archiveCount);
      archivedAt = now;
      await app.mongo.collection("coach_victor_archives").insertOne({
        user_id: userId,
        thread_id: String(threadId),
        message_count: payload.length,
        from_created_at: payload[0]?.created_at,
        to_created_at: payload.at(-1)?.created_at,
        created_at: now,
        storage_backend: "mongodb",
        payload,
      });
      resident = resident.slice(archiveCount);
      archiveIncrement = 1;
    }
  }
  const set: Message = {
    user_id: userId,
    recent_messages: resident,
    recent_message_count: resident.length,
    storage_mode: "mongodb_archive",
    updated_at: now,
    last_message_at: now,
  };
  if (archivedAt) set.last_archive_at = archivedAt;
  await app.mongo.collection("coach_victor_threads").updateOne(
    { _id: threadId },
    {
      $set: set,
      $unset: { messages: "" },
      $setOnInsert: { created_at: thread?.created_at ?? now, archive_count: 0 },
      ...(archiveIncrement
        ? { $inc: { archive_count: archiveIncrement } }
        : {}),
    },
    { upsert: true },
  );
  return threadId;
}
