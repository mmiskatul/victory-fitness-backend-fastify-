import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { AppError } from "../lib/errors.js";
import { idFilter, paginated } from "../lib/mongo.js";
import { serialize } from "../lib/serialize.js";
import { generateJson } from "../services/llm.js";
import { normalizedTier, subscriptionAccess } from "../plugins/auth.js";
import {
  deleteStoredMedia,
  uploadMasterclassAudio,
  uploadWorkoutVideo,
} from "../services/storage.js";

const flexible = Type.Object({}, { additionalProperties: true });
const applicationSchema = Type.Object({
  first_name: Type.String(),
  last_name: Type.String(),
  email: Type.String(),
  phone_number: Type.Optional(Type.String()),
  goal: Type.String(),
  obstacle: Type.String(),
  investment: Type.String(),
  commitment: Type.String(),
  injury: Type.String(),
  additional_notes: Type.Optional(Type.String()),
  agreement_accepted: Type.Optional(Type.Boolean()),
});
const adminStatusSchema = Type.Object({
  status: Type.Optional(Type.String()),
  admin_notes: Type.Optional(Type.String()),
});
const masterclassSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ minLength: 1, maxLength: 4000 }),
  category: Type.String({ minLength: 1, maxLength: 120 }),
  duration: Type.String({ minLength: 1, maxLength: 40 }),
  educationalContent: Type.Optional(Type.String({ maxLength: 10_000 })),
  thumbnailUrl: Type.Optional(Type.String({ maxLength: 20_000_000 })),
  videoUrl: Type.Optional(Type.String({ maxLength: 2000 })),
  videoSource: Type.Optional(
    Type.String({ pattern: "^(VIMEO|YOUTUBE|UPLOAD)$" }),
  ),
  video_base64: Type.Optional(
    Type.String({ minLength: 32, maxLength: 40_000_000 }),
  ),
  video_mime_type: Type.Optional(Type.String({ maxLength: 120 })),
  video_file_name: Type.Optional(Type.String({ maxLength: 255 })),
  audioUrl: Type.Optional(Type.String({ maxLength: 1000 })),
  audio_base64: Type.Optional(
    Type.String({ minLength: 32, maxLength: 40_000_000 }),
  ),
  audio_mime_type: Type.Optional(Type.String({ maxLength: 120 })),
  audio_file_name: Type.Optional(Type.String({ maxLength: 255 })),
  clear_audio: Type.Optional(Type.Boolean()),
});
const defaultHabits = [
  {
    id: "hydration",
    title: "Hydration",
    subtitle: "Support energy and recovery",
    icon: "water-outline",
    done: true,
  },
  {
    id: "sleep-7h",
    title: "7h+ Sleep",
    subtitle: "Protect repair and recovery",
    icon: "moon-outline",
    done: true,
  },
  {
    id: "zone-2",
    title: "Zone 2 Cardio",
    subtitle: "Aerobic base for heart health",
    icon: "heart-outline",
    done: false,
  },
  {
    id: "breathwork",
    title: "Breathwork",
    subtitle: "Downshift stress response",
    icon: "reorder-two-outline",
    done: false,
  },
  {
    id: "steps-8k",
    title: "8k Steps",
    subtitle: "Maintain a steady movement baseline",
    icon: "walk-outline",
    done: false,
  },
];
const defaultHealCategories = [
  ["hbp", "HIGH BLOOD PRESSURE", "#F59E0B"],
  ["diabetes", "DIABETES", "#4F8EF7"],
  ["bodyfat", "BODY FAT", "#6366F1"],
  ["liver", "HEALTHY LIVER", "#EF4444"],
  ["immunity", "IMMUNITY AND INFECTION", "#FF6B6B"],
  ["mental", "MENTAL HEALTH AND ANXIETY", "#F97316"],
  ["heart", "HEART HEALTH", "#00C9A7"],
  ["respiratory", "RESPIRATORY HEALTH", "#10B981"],
  ["skin", "SKIN CONDITIONS", "#A855F7"],
  ["recovery", "POST WORKOUT RECOVERY", "#EC4899"],
].map(([id, label, color]) => ({ id, label, image: "", color }));
const defaultQuickActions = [
  ["log-bio", "Log Bio", "#4F8EF7"],
  ["fasting", "Fasting", "#F59E0B"],
  ["heal-food", "Heal with Food", "#10B981"],
  ["masterclass", "Masterclass", "#4F8EF7"],
  ["circles", "Circles", "#F472B6"],
].map(([id, label, color]) => ({ id, label, subtitle: "", image: "", color }));
const defaultMasterclasses = [
  {
    id: "masterclass-heart-zone2",
    title: "Zone 2 For Heart Health",
    category: "Science",
    duration: "15:00",
    description:
      "Build aerobic capacity, improve recovery, and support long-term cardiovascular resilience.",
    videoUrl: "https://vimeo.com/740239410",
    videoSource: "VIMEO",
    audioUrl: "",
    educationalContent: "",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1530026405186-ed1f139313f8?w=600&q=80",
  },
  {
    id: "masterclass-recovery-blueprint",
    title: "Post Workout Recovery Blueprint",
    category: "Nutrition",
    duration: "18:00",
    description:
      "Use sleep, hydration, and recovery windows to turn training stress into adaptation.",
    videoUrl: "https://vimeo.com/847239103",
    videoSource: "VIMEO",
    audioUrl: "",
    educationalContent: "",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1541781774459-bb2a1b920155?w=600&q=80",
  },
];

const adminMasterclass = (record: Record<string, any>) => ({
  id: String(record.id ?? record._id ?? randomUUID().replace(/-/g, "")),
  title: String(record.title ?? "").trim(),
  category: String(record.category ?? "").trim(),
  duration: String(record.duration ?? "").trim(),
  description: String(record.description ?? "").trim(),
  videoUrl: String(record.videoUrl ?? record.video_url ?? "").trim(),
  videoSource: String(
    record.videoSource ?? record.video_source ?? "VIMEO",
  ).toUpperCase(),
  audioUrl: String(record.audioUrl ?? record.audio_url ?? "").trim(),
  educationalContent: String(
    record.educationalContent ?? record.educational_content ?? "",
  ).trim(),
  thumbnailUrl: String(
    record.thumbnailUrl ?? record.thumbnail ?? record.thumbnail_url ?? "",
  ).trim(),
});

const normalizeMasterclassVideo = (source: string, rawUrl: string): string => {
  const videoSource = source.trim().toUpperCase() || "VIMEO";
  const videoUrl = rawUrl.trim();
  if (!videoUrl || videoSource === "UPLOAD") return videoUrl;
  let parsed: URL;
  try {
    parsed = new URL(videoUrl);
  } catch {
    throw new AppError(400, "Only valid YouTube and Vimeo links are supported");
  }
  if (videoSource === "YOUTUBE") {
    const id =
      parsed.hostname === "youtu.be"
        ? (parsed.pathname.split("/")[1] ?? "")
        : parsed.pathname.startsWith("/embed/")
          ? (parsed.pathname.split("/embed/")[1]?.split("/")[0] ?? "")
          : parsed.pathname.startsWith("/shorts/")
            ? (parsed.pathname.split("/shorts/")[1]?.split("/")[0] ?? "")
            : (parsed.searchParams.get("v") ?? "");
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      throw new AppError(400, "Use a valid YouTube link");
    }
    return `https://www.youtube.com/embed/${id}?playsinline=1&rel=0`;
  }
  const id = videoUrl.match(/(?:vimeo\.com\/(?:video\/)?)(\d+)/)?.[1] ?? "";
  if (!id) throw new AppError(400, "Use a valid Vimeo link");
  return `https://player.vimeo.com/video/${id}?autoplay=0&title=0&byline=0&portrait=0&playsinline=1&dnt=1`;
};

const prepareMasterclass = async (
  body: Record<string, any>,
  ownerId: string,
  previous?: Record<string, any>,
): Promise<Record<string, any>> => {
  const videoSource = String(body.videoSource ?? "VIMEO").toUpperCase();
  const videoUrl = body.video_base64
    ? await uploadWorkoutVideo(
        ownerId,
        String(body.video_base64),
        String(body.video_mime_type ?? "video/mp4"),
        body.video_file_name ? String(body.video_file_name) : undefined,
        "masterclass-videos",
      )
    : normalizeMasterclassVideo(videoSource, String(body.videoUrl ?? ""));
  let audioUrl = String(body.audioUrl ?? "").trim();
  if (body.clear_audio) audioUrl = "";
  else if (body.audio_base64) {
    audioUrl = await uploadMasterclassAudio(
      ownerId,
      String(body.audio_base64),
      String(body.audio_mime_type ?? "audio/mpeg"),
      body.audio_file_name ? String(body.audio_file_name) : undefined,
    );
  }
  const item = adminMasterclass({ ...body, videoUrl, videoSource, audioUrl });
  if (previous) {
    await Promise.all([
      previous.videoUrl && previous.videoUrl !== item.videoUrl
        ? deleteStoredMedia(previous.videoUrl)
        : Promise.resolve(),
      previous.audioUrl && previous.audioUrl !== item.audioUrl
        ? deleteStoredMedia(previous.audioUrl)
        : Promise.resolve(),
    ]);
  }
  return item;
};

const coachingApplication = (record: Record<string, any>) => {
  const firstName = String(record.first_name ?? "").trim();
  const lastName = String(record.last_name ?? "").trim();
  return {
    id: String(record._id ?? record.id ?? ""),
    user_id: String(record.user_id ?? ""),
    first_name: firstName,
    last_name: lastName,
    full_name: `${firstName} ${lastName}`.trim(),
    email: String(record.email ?? "")
      .trim()
      .toLowerCase(),
    phone_number: String(record.phone_number ?? "").trim(),
    goal: String(record.goal ?? "").trim(),
    obstacle: String(record.obstacle ?? "").trim(),
    investment: String(record.investment ?? "").trim(),
    commitment: String(record.commitment ?? "").trim(),
    injury: String(record.injury ?? "").trim(),
    additional_notes: String(record.additional_notes ?? "").trim(),
    agreement_accepted: record.agreement_accepted !== false,
    status: String(record.status ?? "NEW"),
    admin_notes: String(record.admin_notes ?? ""),
    created_at: record.created_at,
    updated_at: record.updated_at ?? record.created_at,
  };
};

const supportMessage = (record: Record<string, any>) => ({
  id: String(record._id ?? record.id ?? ""),
  user_id: String(record.user_id ?? ""),
  user_name: String(record.user_name ?? "Member"),
  user_email: String(record.user_email ?? "").toLowerCase(),
  subject: String(record.subject ?? ""),
  message: String(record.message ?? ""),
  status: String(record.status ?? "OPEN"),
  admin_notes: String(record.admin_notes ?? ""),
  created_at: record.created_at,
  updated_at: record.updated_at ?? record.created_at,
});
const adminUser = (record: Record<string, any>) => {
  const tier = normalizedTier(
    record.subscription_tier ?? record.subscription_role,
  );
  const status = ["ACTIVE", "INACTIVE", "PENDING"].includes(
    String(record.status ?? "").toUpperCase(),
  )
    ? String(record.status).toUpperCase()
    : record.is_verified
      ? "ACTIVE"
      : "PENDING";
  return {
    id: String(record._id ?? ""),
    fullName: String(record.name ?? "Unknown"),
    email: String(record.email ?? ""),
    role: String(record.role ?? (record.is_admin ? "admin" : "user")),
    status,
    isVerified: Boolean(record.is_verified),
    contactNumber: String(record.contact_number ?? ""),
    country: String(record.country ?? ""),
    createdAt: record.created_at ?? new Date(),
    updatedAt: record.updated_at ?? record.created_at ?? new Date(),
    profileImage: String(record.profile_image ?? ""),
    subscription_tier: tier,
    subscription_role: normalizedTier(record.subscription_role ?? tier),
    subscription_status: String(
      record.subscription_status ?? (tier === "NONE" ? "NONE" : "ACTIVE"),
    ),
    subscription_started_at: record.subscription_started_at ?? null,
    subscription_confirmed_at: record.subscription_confirmed_at ?? null,
    subscription_billing_cycle: String(
      record.subscription_billing_cycle ?? "yearly",
    ),
    subscription_is_purchased: Boolean(record.subscription_is_purchased),
    subscription_purchase_source: String(
      record.subscription_purchase_source ?? "",
    ),
    subscription_access: subscriptionAccess[tier] ?? [],
  };
};
const adminUserListItem = (record: Record<string, any>) => {
  const user = record.fullName !== undefined ? record : adminUser(record);
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    status: user.status,
    isVerified: user.isVerified,
    contactNumber: user.contactNumber,
    country: user.country,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    profileImage: user.profileImage,
  };
};

const userTable = async (
  app: FastifyInstance,
  query: Record<string, unknown>,
  subscribers = false,
) => {
  const filter: Record<string, any> = subscribers
    ? { subscription_tier: { $ne: "NONE" } }
    : { is_admin: { $ne: true } };
  if (query.query) {
    const search = String(query.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }
  const result = await paginated(app.mongo.collection("users"), filter, query);
  return {
    total: result.total,
    page: result.page,
    limit: result.pageSize,
    users: (result.items as any[]).map((record: any) => adminUser(record)),
  };
};

const userSummary = async (
  app: FastifyInstance,
  year = new Date().getUTCFullYear(),
) => {
  const records = await app.mongo
    .collection("users")
    .find({ is_admin: { $ne: true } })
    .toArray();
  return {
    totalUsers: records.length,
    activeUsers: records.filter(
      (record) => adminUser(record).status === "ACTIVE",
    ).length,
    pendingUsers: records.filter(
      (record) => adminUser(record).status === "PENDING",
    ).length,
    userChart: Array.from({ length: 12 }, (_, month) => {
      const matching = records.filter((record) => {
        const created = new Date(record.created_at ?? "");
        return (
          created.getUTCFullYear() === year && created.getUTCMonth() === month
        );
      });
      return {
        month: new Date(Date.UTC(year, month, 1)).toLocaleString("en-US", {
          month: "short",
          timeZone: "UTC",
        }),
        userCount: matching.length,
        activeUserCount: matching.filter(
          (record) => adminUser(record).status === "ACTIVE",
        ).length,
      };
    }),
  };
};

export default async function adminLongevityRoutes(
  app: FastifyInstance,
): Promise<void> {
  const profileFor = async (user: Record<string, any>) => {
    const collection = app.mongo.collection("longevity_os_profiles");
    const existing = await collection.findOne({ user_id: String(user._id) });
    if (existing) return existing;
    const now = new Date();
    const age = String(user.age ?? "");
    const document = {
      user_id: String(user._id),
      overview: {
        biological_age: age || "N/A",
        chronological_age: age || "N/A",
        trending_years_younger: 0,
        recovery_score: age ? 78 : 0,
        hrv_ms: age ? 52 : 0,
        sleep_score: age ? 76 : 0,
      },
      quick_actions: defaultQuickActions,
      habits: defaultHabits,
      habit_streak_days: 0,
      heal_categories: defaultHealCategories,
      weekly_plan: null,
      created_at: now,
      updated_at: now,
    };
    const inserted = await collection.insertOne(document);
    return { ...document, _id: inserted.insertedId };
  };

  const masterclassItems = async () => {
    const collection = app.mongo.collection("app_content");
    const record = await collection.findOne({ key: "dashboard_masterclasses" });
    if (Array.isArray(record?.items)) return record.items;
    const legacy = await collection
      .find({ type: "masterclass" })
      .sort({ created_at: -1 })
      .toArray();
    const items = legacy.length
      ? legacy.map(adminMasterclass)
      : defaultMasterclasses.map(adminMasterclass);
    await collection.updateOne(
      { key: "dashboard_masterclasses" },
      {
        $setOnInsert: {
          key: "dashboard_masterclasses",
          items,
          created_at: new Date(),
          updated_at: new Date(),
        },
      },
      { upsert: true },
    );
    return items;
  };

  const saveMasterclasses = async (items: Array<Record<string, unknown>>) => {
    await app.mongo.collection("app_content").updateOne(
      { key: "dashboard_masterclasses" },
      {
        $set: { key: "dashboard_masterclasses", items, updated_at: new Date() },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true },
    );
  };

  const longevityMasterclass = (record: Record<string, any>) => {
    const item = adminMasterclass(record);
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      thumbnail: item.thumbnailUrl,
      videoUrl: item.videoUrl,
      videoSource: item.videoSource,
      audioUrl: item.audioUrl,
      category: item.category,
      duration: item.duration,
      educationalContent: item.educationalContent,
    };
  };

  app.get("/longevity-os/dashboard", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const [profile, health, connections, masterclasses, circles] =
      await Promise.all([
        profileFor(user),
        app.mongo
          .collection("health_metric_current")
          .findOne({ user_id: String(user._id) }),
        app.mongo
          .collection("user_provider_connections")
          .find({ user_id: String(user._id) })
          .toArray(),
        masterclassItems(),
        app.mongo
          .collection("app_content")
          .find({ type: "longevity-circle" })
          .toArray(),
      ]);
    const connectionByProvider = new Map(
      connections.map((item) => [String(item.provider), item]),
    );
    const devices = [
      ["fitbit", "Fitbit"],
      ["apple-health", "Apple Health"],
      ["google-fit", "Google Fit"],
      ["garmin", "Garmin"],
    ].map(([id, name]) => {
      const connection = connectionByProvider.get(id!);
      const active = Boolean(
        connection?.connected ?? connection?.status === "connected",
      );
      return {
        id,
        name,
        status: active ? "CONNECTED" : "CONNECT",
        active,
        image: "",
        device_name: String(connection?.device_name ?? ""),
        source_device: String(connection?.source_device ?? ""),
        platform: String(connection?.platform ?? ""),
      };
    });
    return {
      overview: profile.overview,
      quick_actions: profile.quick_actions ?? defaultQuickActions,
      wearables: {
        devices,
        last_synced_at: health?.latest_synced_at ?? health?.updated_at ?? null,
        has_data: Boolean(health),
        sync_message: health
          ? "Your longevity data is up to date."
          : "No data synced yet. Connect a device and press sync to begin your longevity analysis.",
      },
      habits: {
        streak_days: Number(profile.habit_streak_days ?? 0),
        habits: profile.habits ?? defaultHabits,
      },
      heal_categories: profile.heal_categories ?? defaultHealCategories,
      weekly_plan: profile.weekly_plan ?? null,
      masterclasses: masterclasses.map(longevityMasterclass),
      circles: circles.map((item) => ({
        id: String(item._id ?? item.id ?? ""),
        name: String(item.name ?? item.title ?? ""),
        member_count: Number(item.member_count ?? 0),
        description: String(item.description ?? ""),
      })),
    };
  });
  app.get("/longevity-os/heal/categories", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const profile = await profileFor(user);
    return { categories: profile.heal_categories ?? defaultHealCategories };
  });
  app.post("/longevity-os/heal/weekly-plan", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity_plan",
      "Your current plan does not include Longevity plan generation",
    );
    const profile = await profileFor(user);
    const generated = await generateJson(
      "Create a safe seven-day longevity and recovery plan as JSON from: " +
        JSON.stringify(profile),
      {
        summary: "Your weekly longevity plan is ready.",
        sections: [
          {
            id: "recovery",
            title: "Recovery",
            summary: "Build a consistent recovery routine.",
            actions: [],
          },
        ],
      },
    );
    const value = generated as Record<string, any>;
    const plan = {
      status: "success",
      message: String(value.summary ?? "Your weekly longevity plan is ready."),
      plan_sections: Array.isArray(value.sections) ? value.sections : [],
      generated_at: new Date(),
    };
    await app.mongo.collection("longevity_os_profiles").updateOne(
      { user_id: String(user._id) },
      {
        $set: { weekly_plan: plan, updated_at: new Date() },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true },
    );
    return plan;
  });
  app.get("/longevity-os/habits", async (request) => {
    const user = await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const profile = await profileFor(user);
    return {
      streak_days: Number(profile.habit_streak_days ?? 0),
      habits: profile.habits ?? defaultHabits,
    };
  });
  app.patch(
    "/longevity-os/habits/:habitId",
    { schema: { body: Type.Object({ done: Type.Boolean() }) } },
    async (request) => {
      const user = await app.requireFeature(
        request,
        "longevity",
        "Your current plan does not include Longevity OS access",
      );
      const id = (request.params as { habitId: string }).habitId;
      const profile = await profileFor(user);
      const habits = [...(profile?.habits ?? [])];
      const index = habits.findIndex((habit: any) => String(habit.id) === id);
      if (index < 0) throw new AppError(404, "Habit not found");
      habits[index] = {
        ...habits[index],
        ...(request.body as object),
        updated_at: new Date(),
      };
      await app.mongo
        .collection("longevity_os_profiles")
        .updateOne(
          { user_id: String(user._id) },
          { $set: { habits, updated_at: new Date() } },
        );
      return {
        streak_days: Number(profile.habit_streak_days ?? 0),
        habits: serialize(habits),
      };
    },
  );
  app.get("/longevity-os/masterclasses", async (request) => {
    await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    const items = await masterclassItems();
    return { items: items.map(longevityMasterclass) };
  });
  app.get("/longevity-os/circles", async (request) => {
    await app.requireFeature(
      request,
      "longevity",
      "Your current plan does not include Longevity OS access",
    );
    return {
      items: await app.mongo
        .collection("app_content")
        .find({ type: "longevity-circle" })
        .toArray()
        .then(serialize),
    };
  });

  app.post(
    "/applications",
    { schema: { body: applicationSchema } },
    async (request, reply) => {
      const user = await app.requireFeature(
        request,
        "application",
        "Your current plan does not include application access",
      );
      const body = request.body as Record<string, any>;
      if (body.agreement_accepted === false) {
        throw new AppError(
          400,
          "You must accept the agreement before submitting",
        );
      }
      const now = new Date();
      const document = {
        user_id: String(user._id),
        first_name: String(body.first_name ?? "").trim(),
        last_name: String(body.last_name ?? "").trim(),
        email: String(body.email ?? "")
          .trim()
          .toLowerCase(),
        phone_number: String(body.phone_number ?? "").trim(),
        goal: String(body.goal ?? "").trim(),
        obstacle: String(body.obstacle ?? "").trim(),
        investment: String(body.investment ?? "").trim(),
        commitment: String(body.commitment ?? "").trim(),
        injury: String(body.injury ?? "").trim(),
        additional_notes: String(body.additional_notes ?? "").trim(),
        agreement_accepted: true,
        status: "NEW",
        admin_notes: "",
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("coaching_applications")
        .insertOne(document);
      return reply
        .code(201)
        .send(coachingApplication({ ...document, _id: result.insertedId }));
    },
  );
  app.post(
    "/support/messages",
    {
      schema: {
        body: Type.Object({ subject: Type.String(), message: Type.String() }),
      },
    },
    async (request, reply) => {
      const user = await app.authenticate(request);
      const body = request.body as Record<string, any>;
      const now = new Date();
      const document = {
        user_id: String(user._id),
        user_name: String(user.name ?? "Member").trim() || "Member",
        user_email: String(user.email ?? "")
          .trim()
          .toLowerCase(),
        subject: String(body.subject ?? "").trim(),
        message: String(body.message ?? "").trim(),
        status: "OPEN",
        admin_notes: "",
        created_at: now,
        updated_at: now,
      };
      const result = await app.mongo
        .collection("support_messages")
        .insertOne(document);
      return reply
        .code(201)
        .send(supportMessage({ ...document, _id: result.insertedId }));
    },
  );

  for (const [path, collection] of [
    ["/admin/applications", "coaching_applications"],
    ["/admin/support/messages", "support_messages"],
  ] as const) {
    app.get(path, async (request) => {
      await app.requireAdmin(request);
      const items = await app.mongo
        .collection(collection)
        .find({})
        .sort({ created_at: -1 })
        .toArray();
      return path.includes("applications")
        ? { applications: items.map(coachingApplication) }
        : { messages: items.map(supportMessage) };
    });
  }
  app.patch(
    "/admin/applications/:applicationId",
    { schema: { body: adminStatusSchema } },
    async (request) => {
      await app.requireAdmin(request);
      const result = await app.mongo
        .collection("coaching_applications")
        .findOneAndUpdate(
          idFilter((request.params as { applicationId: string }).applicationId),
          { $set: { ...(request.body as object), updated_at: new Date() } },
          { returnDocument: "after" },
        );
      if (!result) throw new AppError(404, "Application not found");
      return coachingApplication(result);
    },
  );
  app.patch(
    "/admin/support/messages/:messageId",
    { schema: { body: adminStatusSchema } },
    async (request) => {
      await app.requireAdmin(request);
      const result = await app.mongo
        .collection("support_messages")
        .findOneAndUpdate(
          idFilter((request.params as { messageId: string }).messageId),
          { $set: { ...(request.body as object), updated_at: new Date() } },
          { returnDocument: "after" },
        );
      if (!result) throw new AppError(404, "Support message not found");
      return supportMessage(result);
    },
  );

  app.get("/admin/masterclasses", async (request) => {
    await app.requireAdmin(request);
    return { items: (await masterclassItems()).map(adminMasterclass) };
  });
  app.post(
    "/admin/masterclasses",
    { schema: { body: masterclassSchema } },
    async (request, reply) => {
      const admin = await app.requireAdmin(request);
      const item = await prepareMasterclass(
        {
          ...(request.body as object),
          id: randomUUID().replace(/-/g, ""),
        },
        String(admin._id),
      );
      const items = await masterclassItems();
      await saveMasterclasses([item, ...items]);
      return reply.code(201).send(item);
    },
  );
  app.patch(
    "/admin/masterclasses/:masterclassId",
    { schema: { body: masterclassSchema } },
    async (request) => {
      const admin = await app.requireAdmin(request);
      const id = (request.params as { masterclassId: string }).masterclassId;
      const items = await masterclassItems();
      const index = items.findIndex((item: any) => String(item.id) === id);
      if (index < 0) throw new AppError(404, "Masterclass not found");
      const previous = adminMasterclass(items[index]!);
      const updated = await prepareMasterclass(
        { ...(request.body as object), id },
        String(admin._id),
        previous,
      );
      items[index] = updated;
      await saveMasterclasses(items);
      return updated;
    },
  );
  app.delete("/admin/masterclasses/:masterclassId", async (request) => {
    await app.requireAdmin(request);
    const id = (request.params as { masterclassId: string }).masterclassId;
    const items = await masterclassItems();
    const next = items.filter((item: any) => String(item.id) !== id);
    if (next.length === items.length) {
      throw new AppError(404, "Masterclass not found");
    }
    await saveMasterclasses(next);
    const deleted = items.find((item: any) => String(item.id) === id);
    await Promise.all([
      deleteStoredMedia(deleted?.videoUrl ?? deleted?.video_url),
      deleteStoredMedia(deleted?.audioUrl ?? deleted?.audio_url),
    ]);
    return { status: "success", message: "Masterclass deleted" };
  });

  app.get("/admin/subscribers", async (request) => {
    await app.requireAdmin(request);
    const table = await userTable(
      app,
      request.query as Record<string, unknown>,
      true,
    );
    return {
      ...table,
      users: table.users.map((user: any) => ({
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        subscriptionTier: user.subscription_tier,
        contactNumber: user.contactNumber,
        country: user.country,
        status: user.subscription_status,
        joinedDate: user.createdAt,
        profileImage: user.profileImage,
        subscriptionRole: user.subscription_role,
        subscriptionBillingCycle: user.subscription_billing_cycle,
        subscriptionStartedAt: user.subscription_started_at,
        subscriptionConfirmedAt: user.subscription_confirmed_at,
        subscriptionIsPurchased: user.subscription_is_purchased,
        subscriptionAccess: user.subscription_access,
      })),
    };
  });
  app.get("/admin/users", async (request) => {
    await app.requireAdmin(request);
    const table = await userTable(
      app,
      request.query as Record<string, unknown>,
    );
    return {
      ...table,
      users: table.users.map(adminUserListItem),
    };
  });
  app.get("/admin/user-management", async (request) => {
    await app.requireAdmin(request);
    const query = request.query as Record<string, unknown>;
    return {
      summary: await userSummary(app, Number(query.year) || undefined),
      table: await userTable(app, query),
    };
  });
  app.get("/admin/users/summary", async (request) => {
    await app.requireAdmin(request);
    const query = request.query as Record<string, unknown>;
    return userSummary(app, Number(query.year) || undefined);
  });
  app.get("/admin/users/:userId", async (request) => {
    await app.requireAdmin(request);
    const user = await app.mongo
      .collection("users")
      .findOne(idFilter((request.params as { userId: string }).userId), {
        projection: { password_hash: 0 },
      });
    if (!user) throw new AppError(404, "User not found");
    return adminUser(user);
  });
  app.patch(
    "/admin/users/:userId",
    {
      schema: {
        body: Type.Object({
          fullName: Type.Optional(Type.String()),
          email: Type.Optional(Type.String()),
          role: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          isVerified: Type.Optional(Type.Boolean()),
          contactNumber: Type.Optional(Type.String()),
          country: Type.Optional(Type.String()),
          profileImage: Type.Optional(Type.String()),
        }),
      },
    },
    async (request) => {
      await app.requireAdmin(request);
      const body = request.body as Record<string, any>;
      const update: Record<string, unknown> = { updated_at: new Date() };
      if (body.fullName !== undefined) {
        update.name = String(body.fullName).trim();
      }
      if (body.email !== undefined) {
        update.email = String(body.email).trim().toLowerCase();
      }
      if (body.role !== undefined) update.role = String(body.role).trim();
      if (body.status !== undefined) {
        update.status = String(body.status).toUpperCase();
      }
      if (body.isVerified !== undefined) {
        update.is_verified = Boolean(body.isVerified);
      }
      if (body.contactNumber !== undefined) {
        update.contact_number = String(body.contactNumber).trim();
      }
      if (body.country !== undefined) {
        update.country = String(body.country).trim();
      }
      if (body.profileImage !== undefined) {
        update.profile_image = String(body.profileImage).trim();
      }
      const result = await app.mongo
        .collection("users")
        .findOneAndUpdate(
          idFilter((request.params as { userId: string }).userId),
          { $set: update },
          { returnDocument: "after", projection: { password_hash: 0 } },
        );
      if (!result) throw new AppError(404, "User not found");
      return adminUser(result);
    },
  );
  app.delete("/admin/users/:userId", async (request) => {
    const admin = await app.requireAdmin(request);
    const userId = (request.params as { userId: string }).userId;
    if (!ObjectId.isValid(userId)) {
      throw new AppError(400, "Invalid user id");
    }
    const objectId = new ObjectId(userId);
    const record = await app.mongo
      .collection("users")
      .findOne({ _id: objectId, is_admin: { $ne: true } });
    if (!record) throw new AppError(404, "User not found");
    if (String(record._id) === String(admin._id)) {
      throw new AppError(400, "You cannot delete your own account");
    }
    const result = await app.mongo
      .collection("users")
      .deleteOne({ _id: objectId, is_admin: { $ne: true } });
    if (!result.deletedCount) throw new AppError(404, "User not found");
    return { status: "success", message: "User deleted" };
  });
  app.get("/admin/audit-logs", async (request) => {
    await app.requireAdmin(request);
    const limit = Math.min(
      Math.max(
        Number((request.query as Record<string, unknown>).limit ?? 50),
        1,
      ),
      200,
    );
    const records = await app.mongo
      .collection("admin_audit_logs")
      .find({})
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    return {
      items: records.map((record) => ({
        id: String(record._id ?? ""),
        adminEmail: String(record.admin_email ?? ""),
        action: String(record.action ?? ""),
        resource: String(record.resource ?? ""),
        resourceId: String(record.resource_id ?? ""),
        details: record.details ?? {},
        createdAt: record.created_at,
      })),
    };
  });
}
