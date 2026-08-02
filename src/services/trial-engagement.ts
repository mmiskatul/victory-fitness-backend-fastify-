import type { FastifyInstance } from "fastify";
import type { Document, UpdateFilter } from "mongodb";

export type TrialEngagementKind = "coach_message" | "nutrition_plan";

export function trialEngagementUpdate(
  user: Record<string, unknown>,
  kind: TrialEngagementKind,
  now = new Date(),
): UpdateFilter<Document> | null {
  const rawStartedAt = user.subscription_started_at;
  const startedAt =
    rawStartedAt instanceof Date
      ? rawStartedAt
      : typeof rawStartedAt === "string" || typeof rawStartedAt === "number"
        ? new Date(rawStartedAt)
        : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) return null;

  const day = Math.floor(
    (now.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1_000),
  );
  if (day < 0 || day > 5) return null;

  const update: UpdateFilter<Document> = {
    $addToSet: { "trial_engagement.days": day },
  };
  if (kind === "coach_message") {
    update.$inc = { "trial_engagement.coach_messages": 1 };
  } else {
    update.$set = { "trial_engagement.nutrition_plan_created_at": now };
  }
  return update;
}

export async function recordTrialEngagement(
  app: FastifyInstance,
  user: Record<string, unknown>,
  kind: TrialEngagementKind,
): Promise<void> {
  const update = trialEngagementUpdate(user, kind);
  if (!update || user._id === undefined || user._id === null) return;
  await app.mongo.collection("users").updateOne({ _id: user._id }, update);
}
