import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import bcrypt from "bcryptjs";
import { AppError } from "../lib/errors.js";
import { normalizedTier } from "../plugins/auth.js";
import { uploadProfileImage } from "../services/storage.js";
import { serializeMe } from "../services/users.js";
import { notifyUser } from "../services/push.js";

const partialObject = Type.Partial(
  Type.Object({
    name: Type.String({ maxLength: 160 }),
    email: Type.String({ maxLength: 320 }),
    country: Type.String({ maxLength: 120 }),
    profileImage: Type.String({ maxLength: 4096 }),
    onboarding_completed: Type.Boolean(),
  }),
);
const pushToken = Type.Object({
  token: Type.String({ minLength: 10, maxLength: 500 }),
  platform: Type.Optional(Type.String({ maxLength: 20, default: "unknown" })),
});
const profileImageSchema = Type.Object({
  image_base64: Type.String({ minLength: 1 }),
  mime_type: Type.Optional(Type.String({ maxLength: 120 })),
  file_name: Type.Optional(Type.String({ maxLength: 255 })),
});
const onboardingSchema = Type.Object({
  currentStep: Type.Optional(Type.Integer()),
  language: Type.Optional(Type.String()),
  personalProfile: Type.Optional(
    Type.Object({
      age: Type.Optional(Type.String()),
      gender: Type.Optional(Type.String()),
      height: Type.Optional(Type.String()),
      heightUnit: Type.Optional(Type.String()),
      weight: Type.Optional(Type.String()),
      weightUnit: Type.Optional(Type.String()),
    }),
  ),
  anamnese: Type.Optional(
    Type.Object({
      primaryGoal: Type.Optional(Type.String()),
      activityLevel: Type.Optional(Type.String()),
      daysPerWeek: Type.Optional(Type.String()),
      timePerSession: Type.Optional(Type.String()),
      equipmentAccess: Type.Optional(Type.String()),
      healthConcerns: Type.Optional(Type.Array(Type.String())),
      healthNotes: Type.Optional(Type.String()),
    }),
  ),
  suggestion: Type.Optional(
    Type.Object({
      tier: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
    }),
  ),
  completed: Type.Optional(Type.Boolean()),
});

const onboardingState = (user: Record<string, unknown>) => {
  const stored = (user.onboarding_state ?? {}) as Record<string, unknown>;
  return {
    userId: String(user._id ?? ""),
    currentStep: Number(stored.currentStep ?? 0),
    language: String(stored.language ?? "en"),
    personalProfile: (stored.personalProfile ?? {}) as Record<string, unknown>,
    anamnese: (stored.anamnese ?? {}) as Record<string, unknown>,
    suggestion: stored.suggestion ?? null,
    completed: Boolean(user.onboarding_completed ?? stored.completed),
    updatedAt: stored.updatedAt ?? user.updated_at ?? null,
  };
};

const bodyMetrics = (user: Record<string, unknown>) => {
  const metrics = (user.body_metrics ?? {}) as Record<string, unknown>;
  return {
    age: String(metrics.age ?? ""),
    height: String(metrics.height ?? ""),
    weight: String(metrics.weight ?? ""),
    gender: String(metrics.gender ?? ""),
  };
};

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (request) =>
    serializeMe(app, await app.authenticate(request)),
  );

  app.patch("/me", { schema: { body: partialObject } }, async (request) => {
    const user = await app.authenticate(request);
    const body = request.body as {
      name?: string;
      email?: string;
      country?: string;
      profileImage?: string;
      onboarding_completed?: boolean;
    };
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.email !== undefined) {
      const normalized = body.email.trim().toLowerCase();
      const duplicate = await app.mongo
        .collection("users")
        .findOne({ email: normalized, _id: { $ne: user._id } });
      if (duplicate) throw new AppError(409, "Email already exists");
      update.email = normalized;
    }
    if (body.country !== undefined) update.country = body.country.trim();
    if (body.profileImage !== undefined) {
      update.profile_image = body.profileImage.trim();
    }
    if (body.onboarding_completed !== undefined) {
      update.onboarding_completed = body.onboarding_completed;
    }
    if (Object.keys(update).length) {
      update.updated_at = new Date();
      await app.mongo
        .collection("users")
        .updateOne({ _id: user._id }, { $set: update });
      await app.mongo.collection("community_posts").updateMany(
        { author_id: String(user._id) },
        {
          $set: {
            author_name: update.name ?? user.name,
            author_image: update.profile_image ?? user.profile_image,
          },
        },
      );
    }
    const updated = await app.mongo
      .collection("users")
      .findOne({ _id: user._id });
    if (!updated) throw new AppError(404, "User not found");
    return serializeMe(app, updated);
  });

  app.post(
    "/me/push-token",
    { schema: { body: pushToken } },
    async (request) => {
      const user = await app.authenticate(request);
      const body = request.body as {
        token: string;
        platform?: string;
      };
      const entry = {
        token: body.token.trim(),
        platform: body.platform?.trim().toLowerCase() || "unknown",
        updated_at: new Date(),
      };
      const tokens = (Array.isArray(user.push_tokens) ? user.push_tokens : [])
        .filter((item: any) => item?.token !== entry.token)
        .concat(entry)
        .slice(-10);
      await app.mongo
        .collection("users")
        .updateOne({ _id: user._id }, { $set: { push_tokens: tokens } });
      return { registered: true };
    },
  );

  app.delete(
    "/me/push-token",
    { schema: { body: pushToken } },
    async (request) => {
      const user = await app.authenticate(request);
      const token = (request.body as { token: string }).token.trim();
      await app.mongo.collection("users").updateOne({ _id: user._id }, {
        $pull: { push_tokens: { token } },
      } as any);
      return { removed: true };
    },
  );

  app.get("/me/notifications", async (request) => {
    const user = await app.authenticate(request);
    const items = Array.isArray(user.app_notifications)
      ? user.app_notifications
      : [];
    return { items: [...items].reverse() };
  });

  app.delete("/me/notifications/:notificationId", async (request) => {
    const user = await app.authenticate(request);
    const { notificationId } = request.params as { notificationId: string };
    const result = await app.mongo
      .collection("users")
      .updateOne({ _id: user._id }, {
        $pull: { app_notifications: { id: notificationId } },
      } as any);
    return { deleted: result.modifiedCount > 0 };
  });

  app.patch("/me/notifications/:notificationId/read", async (request) => {
    const user = await app.authenticate(request);
    const { notificationId } = request.params as { notificationId: string };
    const result = await app.mongo
      .collection("users")
      .updateOne(
        { _id: user._id, "app_notifications.id": notificationId },
        { $set: { "app_notifications.$.read": true } },
      );
    return { read: result.modifiedCount > 0 };
  });

  app.get("/me/activity-notifications/dismissed", async (request) => {
    const user = await app.authenticate(request);
    return {
      ids: (user.dismissed_activity_notification_ids ?? [])
        .map(String)
        .filter(Boolean),
    };
  });

  app.delete("/me/activity-notifications/:notificationId", async (request) => {
    const user = await app.authenticate(request);
    const id = (
      request.params as { notificationId: string }
    ).notificationId.trim();
    if (!id) throw new AppError(400, "Notification id is required");
    await app.mongo
      .collection("users")
      .updateOne(
        { _id: user._id },
        { $addToSet: { dismissed_activity_notification_ids: id } },
      );
    return { deleted: true };
  });

  app.get("/me/onboarding", async (request) =>
    onboardingState(await app.authenticate(request)),
  );

  app.patch(
    "/me/onboarding",
    { schema: { body: onboardingSchema } },
    async (request) => {
      const user = await app.authenticate(request);
      const body = request.body as Record<string, unknown>;
      const current = onboardingState(user);
      const next = {
        ...current,
        ...body,
        personalProfile: {
          ...current.personalProfile,
          ...((body.personalProfile ?? {}) as object),
        },
        updatedAt: new Date(),
      };
      const metrics = { ...bodyMetrics(user) };
      const profile = next.personalProfile as Record<string, unknown>;
      for (const field of ["age", "gender", "height", "weight"]) {
        if (profile[field] !== undefined) {
          metrics[field as keyof typeof metrics] = String(profile[field]);
        }
      }
      await app.mongo.collection("users").updateOne(
        { _id: user._id },
        {
          $set: {
            onboarding_state: next,
            onboarding_completed:
              body.completed ?? user.onboarding_completed ?? false,
            body_metrics: metrics,
            updated_at: new Date(),
          },
        },
      );
      return next;
    },
  );

  const imageHandler = async (
    request: Parameters<typeof app.authenticate>[0],
    admin = false,
  ) => {
    const user = admin
      ? await app.requireAdmin(request)
      : await app.authenticate(request);
    const body = request.body as {
      image_base64: string;
      mime_type: string;
      file_name?: string;
    };
    const imageUrl = await uploadProfileImage(
      String(user._id),
      body.image_base64,
      body.mime_type ?? "image/jpeg",
      body.file_name,
    );
    await app.mongo
      .collection("users")
      .updateOne(
        { _id: user._id },
        { $set: { profile_image: imageUrl, updated_at: new Date() } },
      );
    await app.mongo
      .collection("community_posts")
      .updateMany(
        { author_id: String(user._id) },
        { $set: { author_image: imageUrl } },
      );
    return { image_url: imageUrl };
  };

  app.post(
    "/me/profile-image",
    { schema: { body: profileImageSchema } },
    (request) => imageHandler(request),
  );

  app.patch(
    "/me/subscription",
    {
      schema: {
        body: Type.Object({
          subscription_tier: Type.String(),
          billing_cycle: Type.Optional(Type.String()),
          confirm_payment: Type.Optional(Type.Boolean({ default: true })),
          plan_id: Type.Optional(Type.String({ maxLength: 120 })),
        }),
      },
    },
    async (request) => {
      const user = await app.authenticate(request);
      const body = request.body as Record<string, unknown>;
      const tier = normalizedTier(body.subscription_tier);
      const confirmed = body.confirm_payment !== false && tier !== "NONE";
      const status = confirmed ? "ACTIVE" : "NONE";
      const now = new Date();
      const purchased = confirmed;
      const billingCycle =
        tier === "NONE" ? "yearly" : String(body.billing_cycle ?? "yearly");
      await app.mongo.collection("users").updateOne(
        { _id: user._id },
        {
          $set: {
            subscription_tier: tier,
            subscription_role: tier,
            subscription_status: status,
            subscription_billing_cycle: billingCycle,
            subscription_is_purchased: purchased,
            subscription_purchase_source: purchased ? "manual_confirm" : "",
            subscription_plan_id: purchased ? String(body.plan_id ?? "") : "",
            subscription_started_at:
              tier === "NONE" ? null : (user.subscription_started_at ?? now),
            subscription_confirmed_at: purchased
              ? now
              : tier === "NONE"
                ? null
                : (user.subscription_confirmed_at ?? null),
            updated_at: now,
          },
        },
      );
      const updated = await app.mongo
        .collection("users")
        .findOne({ _id: user._id });
      if (!updated) throw new AppError(404, "User not found");
      if (
        (normalizedTier(user.subscription_tier) !== tier ||
          String(user.subscription_status ?? "") !== status) &&
        status === "ACTIVE"
      ) {
        await notifyUser(
          app,
          updated,
          `${tier
            .replaceAll("_", " ")
            .toLowerCase()
            .replace(/\b\w/g, (letter) =>
              letter.toUpperCase(),
            )} plan activated`,
          "Your Victory Fitness plan is active and your included features are ready.",
          "subscription_activated",
          { type: "subscription", tier, route: "/profile" },
        );
      }
      return serializeMe(app, updated);
    },
  );

  app.get("/me/body-metrics", async (request) =>
    bodyMetrics(await app.authenticate(request)),
  );

  app.patch(
    "/me/body-metrics",
    {
      schema: {
        body: Type.Partial(
          Type.Object({
            age: Type.String({ maxLength: 30 }),
            height: Type.String({ maxLength: 30 }),
            weight: Type.String({ maxLength: 30 }),
            gender: Type.String({ maxLength: 80 }),
          }),
        ),
      },
    },
    async (request) => {
      const user = await app.authenticate(request);
      const next = { ...bodyMetrics(user), ...(request.body as object) };
      for (const key of Object.keys(next) as Array<keyof typeof next>) {
        next[key] = String(next[key]).trim();
      }
      await app.mongo
        .collection("users")
        .updateOne(
          { _id: user._id },
          { $set: { body_metrics: next, updated_at: new Date() } },
        );
      return next;
    },
  );

  const adminProfile = (user: Record<string, unknown>) => ({
    id: String(user._id ?? ""),
    fullName: String(user.name ?? ""),
    email: String(user.email ?? ""),
    country: String(user.country ?? ""),
    contactNumber: String(user.contact_number ?? ""),
    profileImage: String(user.profile_image ?? ""),
    role: String(user.role ?? "admin"),
    isVerified: Boolean(user.is_verified ?? true),
  });

  app.get("/admin/me", async (request) =>
    adminProfile(await app.requireAdmin(request)),
  );

  app.patch(
    "/admin/me",
    {
      schema: {
        body: Type.Object({
          fullName: Type.Optional(Type.String()),
          country: Type.Optional(Type.String()),
          contactNumber: Type.Optional(Type.String()),
        }),
      },
    },
    async (request) => {
      const admin = await app.requireAdmin(request);
      const body = request.body as Record<string, unknown>;
      const update: Record<string, unknown> = { updated_at: new Date() };
      if (body.fullName !== undefined) {
        update.name = String(body.fullName).trim();
      }
      if (body.country !== undefined) {
        update.country = String(body.country).trim();
      }
      if (body.contactNumber !== undefined) {
        update.contact_number = String(body.contactNumber).trim();
      }
      await app.mongo
        .collection("users")
        .updateOne({ _id: admin._id }, { $set: update });
      const updated = await app.mongo
        .collection("users")
        .findOne({ _id: admin._id });
      if (!updated) throw new AppError(404, "Admin user not found");
      return adminProfile(updated);
    },
  );

  app.post(
    "/admin/me/profile-image",
    { schema: { body: profileImageSchema } },
    (request) => imageHandler(request, true),
  );

  app.post(
    "/admin/me/change-password",
    {
      schema: {
        body: Type.Object({
          current_password: Type.String({ minLength: 1, maxLength: 128 }),
          new_password: Type.String({ minLength: 8, maxLength: 128 }),
        }),
      },
    },
    async (request) => {
      const admin = await app.requireAdmin(request);
      const body = request.body as {
        current_password: string;
        new_password: string;
      };
      if (
        !admin.password_hash ||
        !(await bcrypt.compare(
          body.current_password,
          String(admin.password_hash),
        ))
      ) {
        throw new AppError(400, "Current password is incorrect");
      }
      if (body.current_password === body.new_password) {
        throw new AppError(
          400,
          "New password must be different from the current password",
        );
      }
      await app.mongo.collection("users").updateOne(
        { _id: admin._id },
        {
          $set: {
            password_hash: await bcrypt.hash(body.new_password, 12),
            updated_at: new Date(),
          },
        },
      );
      return { status: "success" };
    },
  );
}
