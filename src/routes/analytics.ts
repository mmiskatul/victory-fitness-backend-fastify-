import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { serialize } from "../lib/serialize.js";

const percentageChange = (current: number, previous: number) =>
  previous
    ? Number((((current - previous) / previous) * 100).toFixed(1))
    : current
      ? 100
      : 0;
const paid = (user: any) =>
  Boolean(user.subscription_is_purchased) ||
  ["ACTIVE", "PAID"].includes(
    String(user.subscription_status ?? "").toUpperCase(),
  );
const trialStart = (user: any): Date | null =>
  user.subscription_started_at instanceof Date
    ? user.subscription_started_at
    : null;
const cohortKey = (date: Date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

export default async function analyticsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/admin/dashboard/overview", async (request) => {
    await app.requireAdmin(request);
    const now = new Date();
    const selectedYear = Number(
      (request.query as any).year ?? now.getUTCFullYear(),
    );
    const start = new Date(Date.UTC(selectedYear, 0, 1));
    const end = new Date(Date.UTC(selectedYear + 1, 0, 1));
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    weekStart.setUTCHours(0, 0, 0, 0);
    const users = app.mongo.collection("users");
    const [
      totalUsers,
      workoutsThisWeek,
      challengeCompletions,
      activeChallenges,
      readyChallenges,
      recent,
      monthly,
    ] = await Promise.all([
      users.countDocuments({ is_admin: { $ne: true } }),
      app.mongo
        .collection("workouts")
        .countDocuments({ created_at: { $gte: weekStart } }),
      app.mongo
        .collection("challenge_memberships")
        .countDocuments({ status: "COMPLETED" }),
      app.mongo.collection("challenges").countDocuments({ status: "ACTIVE" }),
      app.mongo
        .collection("challenges")
        .countDocuments({ status: { $in: ["ACTIVE", "UPCOMING"] } }),
      users
        .find({ is_admin: { $ne: true } })
        .sort({ created_at: -1 })
        .limit(5)
        .toArray(),
      users
        .aggregate([
          {
            $match: {
              is_admin: { $ne: true },
              created_at: { $gte: start, $lt: end },
            },
          },
          {
            $group: { _id: { $month: "$created_at" }, userCount: { $sum: 1 } },
          },
        ])
        .toArray(),
    ]);
    const counts = new Map(
      monthly.map((item) => [Number(item._id), Number(item.userCount)]),
    );
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return {
      totalUsers,
      workoutsThisWeek,
      challengeCompletions,
      activeChallenges,
      readyChallenges,
      vimeoApiStatus: config.vimeoAccessToken ? "connected" : "not_configured",
      userChart: months.map((month, index) => ({
        month,
        userCount: counts.get(index + 1) ?? 0,
        agentCount: 0,
      })),
      recentUsers: serialize(
        recent.map((user) => ({
          id: String(user._id),
          fullName: String(user.name ?? "Unknown"),
          email: user.email,
          status: user.is_verified ? "ACTIVE" : "PENDING",
          createdAt: user.created_at,
          profileImage: String(user.profile_image ?? ""),
        })),
      ),
    };
  });

  app.get("/admin/trials/cohorts", async (request) => {
    await app.requireAdmin(request);
    const now = new Date();
    const users = await app.mongo
      .collection("users")
      .find({ is_admin: { $ne: true }, subscription_started_at: { $ne: null } })
      .toArray();
    const grouped = new Map<string, any>();
    for (const user of users) {
      const started = trialStart(user);
      if (!started) continue;
      const source =
        String(user.signup_source ?? "organic").trim() || "organic";
      const key = `${cohortKey(started)}|${source}`;
      const bucket = grouped.get(key) ?? {
        cohort: cohortKey(started),
        signupSource: source,
        totalUsers: 0,
        convertedUsers: 0,
        dropoutUsers: 0,
        engagedUsersByDay: Object.fromEntries(
          Array.from({ length: 6 }, (_, day) => [String(day), 0]),
        ),
      };
      bucket.totalUsers += 1;
      if (paid(user)) bucket.convertedUsers += 1;
      else if (now.getTime() >= started.getTime() + 5 * 86_400_000) {
        bucket.dropoutUsers += 1;
      }
      for (const day of user.trial_engagement?.days ?? []) {
        if (String(day) in bucket.engagedUsersByDay) {
          bucket.engagedUsersByDay[String(day)] += 1;
        }
      }
      grouped.set(key, bucket);
    }
    const cohorts = [...grouped.values()]
      .map((item) => ({
        ...item,
        conversionRate: item.totalUsers
          ? Number(((item.convertedUsers / item.totalUsers) * 100).toFixed(2))
          : 0,
      }))
      .sort((a, b) => b.cohort.localeCompare(a.cohort));
    return { cohorts };
  });

  app.get("/admin/trials/dropouts", async (request) => {
    await app.requireAdmin(request);
    const limit = Math.min(
      Math.max(Number((request.query as any).limit ?? 100), 1),
      500,
    );
    const now = new Date();
    const records = await app.mongo
      .collection("users")
      .find({
        is_admin: { $ne: true },
        marketing_consent: true,
        subscription_started_at: { $ne: null },
      })
      .sort({ subscription_started_at: -1 })
      .limit(limit)
      .toArray();
    const users = records.flatMap((user) => {
      const started = trialStart(user);
      if (
        !started ||
        paid(user) ||
        now.getTime() < started.getTime() + 5 * 86_400_000
      ) {
        return [];
      }
      const days = (user.trial_engagement?.days ?? [])
        .map(Number)
        .filter(Number.isFinite);
      return [
        {
          id: String(user._id),
          fullName: String(user.name ?? "Unknown"),
          email: String(user.email ?? ""),
          signupSource: String(user.signup_source ?? "organic"),
          cohort: cohortKey(started),
          trialStartedAt: started,
          marketingConsent: true,
          lastEngagedDay: days.length ? Math.max(...days) : null,
          coachMessages: Math.max(
            Number(user.trial_engagement?.coach_messages ?? 0),
            0,
          ),
          nutritionPlanCreated: Boolean(
            user.trial_engagement?.nutrition_plan_created_at,
          ),
          campaignDaysSent: (
            [
              ...new Set(
                (user.trial_campaign_sent_days ?? [])
                  .map(Number)
                  .filter(Number.isFinite),
              ),
            ] as number[]
          ).sort((a, b) => a - b),
        },
      ];
    });
    return { total: users.length, users: serialize(users) };
  });

  app.get("/admin/analytics/trial-conversion", async (request) => {
    await app.requireAdmin(request);
    const now = new Date();
    const all = await app.mongo
      .collection("users")
      .find({ is_admin: { $ne: true } })
      .toArray();
    let activeTrials = 0;
    let continuedAfterTrial = 0;
    let trialEndedNotContinued = 0;
    const users = all
      .flatMap((user) => {
        const started = trialStart(user);
        if (!started) return [];
        const ends = new Date(started.getTime() + 5 * 86_400_000);
        let status: string;
        if (now < ends) {
          status = "ACTIVE_TRIAL";
          activeTrials += 1;
        } else if (paid(user)) {
          status = "CONTINUED_AFTER_TRIAL";
          continuedAfterTrial += 1;
        } else {
          status = "TRIAL_ENDED_NOT_CONTINUED";
          trialEndedNotContinued += 1;
        }
        return [
          {
            id: String(user._id),
            fullName: String(user.name ?? "User"),
            email: String(user.email ?? ""),
            trialStartedAt: started,
            trialEndsAt: ends,
            status,
            subscriptionTier: String(user.subscription_tier ?? "NONE"),
            subscriptionStatus: String(user.subscription_status ?? "NONE"),
            subscriptionIsPurchased: Boolean(user.subscription_is_purchased),
          },
        ];
      })
      .sort((a, b) => b.trialStartedAt.getTime() - a.trialStartedAt.getTime());
    const totalSubscriptions = all.filter(paid).length;
    const decided = continuedAfterTrial + trialEndedNotContinued;
    return {
      totalUsers: all.length,
      totalSubscriptions,
      trialUsers: users.length,
      activeTrials,
      continuedAfterTrial,
      trialEndedNotContinued,
      conversionRate: decided
        ? Number(((continuedAfterTrial / decided) * 100).toFixed(1))
        : 0,
      chart: [
        { name: "Active trial", users: activeTrials },
        { name: "Continued", users: continuedAfterTrial },
        { name: "Not continued", users: trialEndedNotContinued },
        { name: "Subscriptions", users: totalSubscriptions },
      ],
      users: serialize(users),
    };
  });

  app.get("/admin/dashboard/user-statistics", async (request) => {
    await app.requireAdmin(request);
    const period = Math.min(
      Math.max(Number((request.query as any).period ?? 30), 1),
      365,
    );
    const now = new Date();
    const currentStart = new Date(now.getTime() - period * 86_400_000);
    const previousStart = new Date(
      currentStart.getTime() - period * 86_400_000,
    );
    const records = await app.mongo
      .collection("users")
      .find({ is_admin: { $ne: true } })
      .toArray();
    const inRange = (user: any, start: Date, end = now) =>
      user.created_at instanceof Date &&
      user.created_at >= start &&
      user.created_at < end;
    const newly = records.filter((item) => inRange(item, currentStart)).length;
    const previousNew = records.filter((item) =>
      inRange(item, previousStart, currentStart),
    ).length;
    const tiers = new Map<string, number>();
    records.forEach((item) =>
      tiers.set(
        String(item.subscription_tier ?? "NONE").toUpperCase(),
        (tiers.get(String(item.subscription_tier ?? "NONE").toUpperCase()) ??
          0) + 1,
      ),
    );
    const trials = records.filter((item) => trialStart(item));
    const completed = trials.filter(
      (item) => trialStart(item)!.getTime() < now.getTime() - 7 * 86_400_000,
    );
    const converted = completed.filter(paid);
    const activityCollections = [
      "workouts",
      "nutrition_plans",
      "coach_victor_threads",
    ];
    const activity = await Promise.all(
      activityCollections.flatMap((name) => [
        app.mongo
          .collection(name)
          .find({
            created_at: { $gte: currentStart, $lt: now },
            user_id: { $exists: true },
          })
          .project({ user_id: 1 })
          .toArray(),
        app.mongo
          .collection(name)
          .find({
            created_at: { $gte: previousStart, $lt: currentStart },
            user_id: { $exists: true },
          })
          .project({ user_id: 1 })
          .toArray(),
      ]),
    );
    const activeIds = new Set<string>();
    const previousActiveIds = new Set<string>();
    for (let index = 0; index < activity.length; index += 2) {
      for (const item of activity[index] ?? []) {
        if (item.user_id) activeIds.add(String(item.user_id));
      }
      for (const item of activity[index + 1] ?? []) {
        if (item.user_id) previousActiveIds.add(String(item.user_id));
      }
    }
    return {
      totalRegisteredUsers: records.length,
      totalRegisteredUsersChange: 0,
      newUsers: newly,
      newUsersChange: percentageChange(newly, previousNew),
      activeUsers: activeIds.size,
      activeUsersChange: percentageChange(
        activeIds.size,
        previousActiveIds.size,
      ),
      trialToPaidConversionRate: completed.length
        ? Number(((converted.length / completed.length) * 100).toFixed(1))
        : 0,
      trialToPaidConversionChange: 0,
      churnedUsers: 0,
      churnedUsersChange: 0,
      usersByTier: ["NONE", "SILVER", "GOLD", "PLATINUM", "INNER_CIRCLE"].map(
        (tier) => ({
          tier,
          label: tier
            .replace("_", " ")
            .toLowerCase()
            .replace(/\b\w/g, (letter) => letter.toUpperCase()),
          count: tiers.get(tier) ?? 0,
        }),
      ),
      topUsers: [],
    };
  });

  app.get("/admin/dashboard/workout-statistics", async (request) => {
    await app.requireAdmin(request);
    const period = Math.min(
      Math.max(Number((request.query as any).period ?? 30), 1),
      365,
    );
    const now = new Date();
    const start = new Date(now.getTime() - period * 86_400_000);
    const previousStart = new Date(start.getTime() - period * 86_400_000);
    const collection = app.mongo.collection("workouts");
    const [current, previous] = await Promise.all([
      collection.find({ created_at: { $gte: start, $lt: now } }).toArray(),
      collection
        .find({ created_at: { $gte: previousStart, $lt: start } })
        .toArray(),
    ]);
    const completed = current.filter((item) => item.completed_at);
    const previousCompleted = previous.filter((item) => item.completed_at);
    const grouped = new Map<string, any>();
    for (const item of completed) {
      const key = String(item.workout_id ?? item.template_id ?? item._id);
      const entry = grouped.get(key) ?? {
        name: item.workout_name ?? item.name ?? "Workout",
        count: 0,
        durations: [],
      };
      entry.count += 1;
      if (Number.isFinite(Number(item.duration_minutes ?? item.duration))) {
        entry.durations.push(Number(item.duration_minutes ?? item.duration));
      }
      grouped.set(key, entry);
    }
    const top = [...grouped.values()].sort((a, b) => b.count - a.count)[0];
    const ai = current.filter(
      (item) => String(item.source).toLowerCase() === "ai",
    ).length;
    const previousAi = previous.filter(
      (item) => String(item.source).toLowerCase() === "ai",
    ).length;
    return {
      totalWorkoutsCompleted: completed.length,
      totalWorkoutsCompletedChange: percentageChange(
        completed.length,
        previousCompleted.length,
      ),
      workoutCompletionRate: current.length
        ? Number(((completed.length / current.length) * 100).toFixed(1))
        : 0,
      topWorkout: top
        ? {
            name: top.name,
            count: top.count,
            averageDuration: top.durations.length
              ? Number(
                  (
                    top.durations.reduce(
                      (sum: number, value: number) => sum + value,
                      0,
                    ) / top.durations.length
                  ).toFixed(1),
                )
              : 0,
          }
        : null,
      aiGeneratedWorkouts: ai,
      aiGeneratedWorkoutsChange: percentageChange(ai, previousAi),
      whatsappCompletionCards: 0,
      whatsappCompletionCardsChange: 0,
    };
  });
}
