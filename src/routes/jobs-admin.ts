import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { ObjectId } from "mongodb";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { idFilter } from "../lib/mongo.js";
import { serialize } from "../lib/serialize.js";
import { sendTrialCampaignEmail } from "../services/email.js";
import { generateJson } from "../services/llm.js";
import { notifyUser } from "../services/push.js";

const flexible = Type.Object({}, { additionalProperties: true });
const campaign: Record<number, [string, string]> = {
  0: [
    "Welcome to Victory Gold",
    "Hi {name}, your Gold trial is active. Ask Coach Victor one question right now to get your first win.",
  ],
  1: [
    "Have you set up your meal plan?",
    "Your personalized Nutrition Planner takes about two minutes to set up.",
  ],
  2: [
    "See what Gold can do",
    "Watch your mid-trial Victory Fitness video and choose one feature to try today.",
  ],
  3: [
    "Keep your momentum going",
    "Open Coach Victor or your Nutrition Planner today and keep your progress moving.",
  ],
  4: [
    "Your trial ends tomorrow",
    "Review what you have used so far and get ready to choose your Gold plan.",
  ],
  5: [
    "Your Gold trial is complete",
    "Your trial has ended. Keep your coaching, nutrition, and workout tools by choosing a plan.",
  ],
  7: [
    "Still thinking about Gold?",
    "Your Victory Fitness trial has ended. Come back and keep building your routine.",
  ],
  14: [
    "Your next step is waiting",
    "Return to Victory Fitness and choose the Gold plan when you are ready to continue.",
  ],
};

const cronAuthorized = (request: FastifyRequest): void => {
  const supplied = request.headers.authorization
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (!config.cronSecret || supplied !== config.cronSecret) {
    throw new AppError(401, "Invalid cron authorization");
  }
};

async function processTrialCampaign(app: FastifyInstance) {
  const users = app.mongo.collection("users");
  const records = await users
    .find({ marketing_consent: true, subscription_started_at: { $ne: null } })
    .toArray();
  const now = new Date();
  let processed = 0;
  let skipped = 0;
  for (const user of records) {
    if (
      user.subscription_is_purchased ||
      ["ACTIVE", "PAID"].includes(
        String(user.subscription_status).toUpperCase(),
      )
    ) {
      skipped += 1;
      continue;
    }
    const started =
      user.subscription_started_at instanceof Date
        ? user.subscription_started_at
        : null;
    if (!started) continue;
    const currentDay = Math.floor(
      (now.getTime() - started.getTime()) / 86_400_000,
    );
    const sent = new Set((user.trial_campaign_sent_days ?? []).map(Number));
    const due = Object.keys(campaign)
      .map(Number)
      .filter((day) => day <= currentDay && !sent.has(day))
      .sort((a, b) => a - b);
    if (!due.length) {
      skipped += 1;
      continue;
    }
    for (const day of due) {
      const [title, template] = campaign[day]!;
      let message = template.replace("{name}", String(user.name ?? "there"));
      if (day === 3) {
        const userId = String(user._id);
        const [threads, nutritionPlan] = await Promise.all([
          app.mongo
            .collection("coach_victor_threads")
            .find({ user_id: userId }, { projection: { messages: 1 } })
            .toArray(),
          app.mongo.collection("nutrition_plans").findOne({ user_id: userId }),
        ]);
        const coachMessages = threads.reduce(
          (count, thread) =>
            count +
            (Array.isArray(thread.messages)
              ? thread.messages.filter(
                  (item: any) => String(item?.role).toLowerCase() === "user",
                ).length
              : 0),
          0,
        );
        message = coachMessages
          ? `You have already sent ${coachMessages} message${coachMessages === 1 ? "" : "s"} to Coach Victor.${nutritionPlan ? " Your nutrition plan is ready too." : " Set up your Nutrition Planner today."}`
          : nutritionPlan
            ? "You have started your Nutrition Planner. Open Coach Victor today to keep your progress moving."
            : "You have not tried Coach Victor or the Nutrition Planner yet. Open one today before your trial gets away from you.";
      }
      const winback = day > 5;
      await notifyUser(
        app,
        user,
        title,
        message,
        winback ? `trial_winback_day_${day}` : `trial_day_${day}`,
        {
          route: "/notifications",
          trialDay: day,
          winback,
          fallback: "in_app",
        },
      );
      await users.updateOne(
        { _id: user._id, marketing_consent: true },
        { $addToSet: { trial_campaign_sent_days: day } },
      );
      try {
        await sendTrialCampaignEmail(
          String(user.email ?? ""),
          String(user.name ?? "there"),
          day,
          title,
          message,
        );
      } catch {
        /* inbox delivery succeeded */
      }
      processed += 1;
    }
  }
  let challengeReminders = 0;
  const memberships = await app.mongo
    .collection("challenge_memberships")
    .find({ status: "ACTIVE" })
    .toArray();
  const todayKey = now.toISOString().slice(0, 10);
  for (const membership of memberships) {
    const userId = String(membership.user_id ?? "");
    const challengeId = String(membership.challenge_id ?? "");
    if (!ObjectId.isValid(userId) || !challengeId) continue;
    const startedAt = membership.started_at
      ? new Date(membership.started_at)
      : null;
    const currentDay =
      startedAt && !Number.isNaN(startedAt.getTime())
        ? Math.max(
            Math.floor(
              (Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
              ) -
                Date.UTC(
                  startedAt.getUTCFullYear(),
                  startedAt.getUTCMonth(),
                  startedAt.getUTCDate(),
                )) /
                86_400_000,
            ) + 1,
            1,
          )
        : 1;
    if (membership.plan_progress?.[String(currentDay)]?.completed) continue;
    const [user, challenge] = await Promise.all([
      users.findOne({ _id: new ObjectId(userId), is_admin: { $ne: true } }),
      app.mongo.collection("challenges").findOne(idFilter(challengeId)),
    ]);
    if (!user || !challenge) continue;
    const totalDays = Math.max(Number(challenge.duration_days ?? 0), 1);
    if (currentDay > totalDays) {
      await app.mongo
        .collection("challenge_memberships")
        .updateOne(
          { _id: membership._id },
          { $set: { status: "COMPLETED", completed_at: now, updated_at: now } },
        );
      continue;
    }
    const timeContext = now.getUTCHours() >= 18 ? "evening" : "daytime";
    const reminderKey = `${challengeId}:${todayKey}:${timeContext}`;
    const marked = await users.updateOne(
      { _id: user._id, challenge_reminder_dates: { $ne: reminderKey } },
      { $addToSet: { challenge_reminder_dates: reminderKey } },
    );
    if (!marked.modifiedCount) continue;
    const planDay = (challenge.plan_days ?? []).find(
      (item: any) => Number(item?.day_number ?? 0) === currentDay,
    );
    const taskNames: string[] = [];
    for (const section of planDay?.sections ?? []) {
      const sectionTitle = String(section?.title ?? section?.name ?? "").trim();
      if (sectionTitle) taskNames.push(sectionTitle);
      for (const exercise of section?.exercises ?? []) {
        const exerciseName = String(
          exercise?.name ?? exercise?.title ?? "",
        ).trim();
        if (exerciseName) taskNames.push(exerciseName);
      }
    }
    const taskContext = taskNames.slice(0, 5).join(", ");
    const member = String(user.name ?? "there").trim() || "there";
    const title =
      timeContext === "evening"
        ? "You still have time today"
        : "Your challenge task is waiting";
    const message =
      timeContext === "evening"
        ? `You still have time, ${member}. Complete ${taskContext || "today's planned tasks"} for day ${currentDay} of ${String(challenge.title ?? "your challenge")} before today ends.`
        : `Hi ${member}, day ${currentDay} of ${String(challenge.title ?? "your challenge")} is waiting. Start with ${taskContext || "today's planned tasks"} to keep your progress moving.`;
    await notifyUser(app, user, title, message, "challenge_reminder", {
      type: "challenge",
      challengeId,
      day: currentDay,
      timeContext,
      route: `/challenges/progress/${challengeId}`,
      taskContext,
    });
    challengeReminders += 1;
  }
  return { processed, skipped, challenge_reminders: challengeReminders };
}

async function processNutritionJobs(app: FastifyInstance, limit: number) {
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const standard = await app.mongo
      .collection("nutrition_plan_jobs")
      .findOneAndUpdate(
        { status: "queued" },
        { $set: { status: "processing", updated_at: new Date() } },
        { sort: { created_at: 1 }, returnDocument: "after" },
      );
    const progressive = standard
      ? null
      : await app.mongo
          .collection("nutrition_progressive_plan_jobs")
          .findOneAndUpdate(
            { status: "queued" },
            { $set: { status: "generating_monday", updated_at: new Date() } },
            { sort: { created_at: 1 }, returnDocument: "after" },
          );
    const job = standard ?? progressive;
    if (!job) break;
    const progressiveJob = Boolean(progressive);
    const jobs = app.mongo.collection(
      progressiveJob
        ? "nutrition_progressive_plan_jobs"
        : "nutrition_plan_jobs",
    );
    try {
      const payload = job.payload ?? {};
      const plan = await generateJson(
        `Create a safe ${progressiveJob ? "progressive " : ""}seven-day nutrition plan as JSON from: ${JSON.stringify(payload)}`,
        {
          title: "Personalized 7-Day Nutrition Plan",
          days: Array.from({ length: 7 }, (_, day) => ({
            day: day + 1,
            meals: [],
          })),
        },
      );
      const now = new Date();
      const result = await app.mongo
        .collection(
          progressiveJob ? "nutrition_progressive_plans" : "nutrition_plans",
        )
        .insertOne({
          user_id: String(job.user_id),
          plan,
          profile: payload,
          progressive: progressiveJob,
          created_at: now,
          updated_at: now,
        });
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "completed",
            plan_id: String(result.insertedId),
            result: plan,
            updated_at: now,
          },
        },
      );
      processed += 1;
    } catch (error) {
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            updated_at: new Date(),
          },
        },
      );
      failed += 1;
    }
  }
  return { processed, failed };
}

export default async function jobsAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post("/jobs/trial-campaign", async (request) => {
    cronAuthorized(request);
    return processTrialCampaign(app);
  });
  app.post("/jobs/nutrition", async (request) => {
    cronAuthorized(request);
    const limit = Math.min(
      Math.max(Number((request.query as any).limit ?? 2), 1),
      10,
    );
    return processNutritionJobs(app, limit);
  });

  const notificationRecord = async () => {
    const collection = app.mongo.collection("app_content");
    const existing = await collection.findOne({
      key: { $in: ["dashboard_notifications", "dashboard-notifications"] },
    });
    if (existing) return existing;
    const items = [
      {
        id: "notification-dashboard-online",
        title: "Dashboard Online",
        message:
          "The admin dashboard is connected and ready to manage users, content, and challenges.",
        read: false,
        createdAt: new Date("2026-06-19T00:00:00Z"),
      },
    ];
    await collection.insertOne({
      key: "dashboard_notifications",
      items,
      created_at: new Date(),
      updated_at: new Date(),
    });
    return { key: "dashboard_notifications", items };
  };
  app.get("/admin/notifications", async (request) => {
    await app.requireAdmin(request);
    const record = await notificationRecord();
    return {
      items: serialize(
        [...(record.items ?? record.value ?? [])].sort(
          (a: any, b: any) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      ),
    };
  });
  app.post(
    "/admin/notifications/test",
    { schema: { body: Type.Object({ email: Type.String() }) } },
    async (request) => {
      await app.requireAdmin(request);
      const email = String((request.body as any).email ?? "")
        .trim()
        .toLowerCase();
      const user = await app.mongo
        .collection("users")
        .findOne({ email, is_admin: { $ne: true } });
      if (!user) throw new AppError(404, "App user not found for that email");
      const tokens = (user.push_tokens ?? []).filter(
        (item: any) => item?.token,
      );
      const delivery = await notifyUser(
        app,
        user,
        "Victory Fitness test notification",
        "Push notifications are connected successfully.",
        "test_notification",
        { type: "test_notification", route: "/notifications" },
      );
      return {
        status: delivery.status,
        email,
        registeredDevices: tokens.length,
        delivery,
      };
    },
  );
  app.patch(
    "/admin/notifications/:notificationId",
    {
      schema: {
        body: Type.Object({ read: Type.Optional(Type.Boolean()) }),
      },
    },
    async (request) => {
      await app.requireAdmin(request);
      const id = (request.params as any).notificationId;
      const record = await notificationRecord();
      const items = [...(record.items ?? record.value ?? [])];
      const item = items.find((candidate: any) => String(candidate.id) === id);
      if (!item) throw new AppError(404, "Notification not found");
      item.read = Boolean((request.body as any).read);
      await app.mongo
        .collection("app_content")
        .updateOne(
          { key: String(record.key ?? "dashboard_notifications") },
          { $set: { items, updated_at: new Date() } },
          { upsert: true },
        );
      return serialize(item);
    },
  );
  app.patch("/admin/notifications/actions/read-all", async (request) => {
    await app.requireAdmin(request);
    const record = await notificationRecord();
    const items = (record.items ?? record.value ?? []).map((item: any) => ({
      ...item,
      read: true,
    }));
    await app.mongo
      .collection("app_content")
      .updateOne(
        { key: String(record.key ?? "dashboard_notifications") },
        { $set: { items, updated_at: new Date() } },
        { upsert: true },
      );
    return { items: serialize(items) };
  });
}
